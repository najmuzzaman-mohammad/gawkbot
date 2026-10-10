import Foundation
import SwiftUI
import GawkbotKit

/// The one observable the views read. Owns the broker connection, the
/// roster, per-thread messages, typing state, pending requests, unread
/// counts, and the inbox (`/notch/state`, polled every 3 s while the app is
/// in front). Everything mutates on the main actor.
@MainActor
final class OfficeStore: ObservableObject {
    enum Phase: Equatable {
        case unpaired
        case connecting
        case ready
        case failed(String)
    }

    @Published private(set) var phase: Phase = .unpaired
    /// The office this phone is talking to. Held here, not re-read from the
    /// credential store, so what Settings shows is what is connected even
    /// when the Keychain cannot be read back.
    @Published private(set) var pairing: Pairing? = nil
    @Published private(set) var bots: [Bot] = []
    @Published private(set) var messages: [String: [ChatMessage]] = [:]
    @Published private(set) var typing: Set<String> = []
    @Published private(set) var requests: [BotRequest] = []
    @Published private(set) var unread: [String: Int] = [:]
    @Published private(set) var live = false
    @Published var openThread: String? = nil
    @Published var pairingError: String? = nil
    /// A pairing that arrived by link or scan and is waiting for the person
    /// to confirm it. Never applied on its own: a crafted gawkbot:// link
    /// must not be able to point the app at an attacker's office.
    @Published var proposedPairing: Pairing? = nil
    /// The inbox: every agent's mood and every question waiting on you.
    @Published private(set) var notch: NotchState? = nil
    /// Cards answered on this phone, hidden until a poll confirms they are gone.
    @Published private(set) var hiddenAttention: Set<String> = []
    @Published var tab: AppTab = .inbox

    /// Sounds and haptics for inbox events.
    let feedback: FeedbackPlayer

    /// Talking to the canned office: launched with `-mock`, or looking
    /// around the demo from the pairing screen.
    @Published private(set) var isMock: Bool
    private let credentials: CredentialStore
    private var broker: BrokerAPI?
    private var eventTask: Task<Void, Never>?
    private var typingTimers: [String: Task<Void, Never>] = [:]
    private var pollTask: Task<Void, Never>?
    private var isForeground = true
    private var notchSeq = 0
    static let pollInterval: Duration = .seconds(3)

    init(credentials: CredentialStore, forceMock: Bool) {
        self.credentials = credentials
        self.isMock = forceMock
        self.feedback = FeedbackPlayer()
        if forceMock {
            connect(MockBroker())
        } else if let pairing = credentials.load() {
            self.pairing = pairing
            connect(BrokerClient(baseURL: pairing.brokerURL, token: pairing.token))
        }
    }

    // MARK: - Pairing

    func pair(_ pairing: Pairing) {
        if isMock { clearOffice() }
        let saved = credentials.save(pairing)
        self.pairing = pairing
        // Still connect: the pairing works until the app quits. Say so
        // rather than ask to pair again, unexplained, on the next launch.
        pairingError = saved ? nil : "Connected, but this phone could not save the pairing, so it will ask again the next time the app opens."
        connect(BrokerClient(baseURL: pairing.brokerURL, token: pairing.token))
    }

    /// Parses a link or scanned code into a proposal for the person to confirm.
    @discardableResult
    func propose(text: String) -> Bool {
        guard let p = Pairing.parse(text) else {
            pairingError = "That code is not a gawkbot pairing link."
            return false
        }
        pairingError = nil
        proposedPairing = p
        return true
    }

    var isPaired: Bool { pairing != nil }

    func confirmProposedPairing() {
        guard let p = proposedPairing else { return }
        proposedPairing = nil
        pair(p)
    }

    /// The canned office, for someone with no office to pair with yet (and
    /// for App Review, which has none). Nothing leaves the phone.
    func startDemo() {
        clearOffice()
        isMock = true
        pairingError = nil
        connect(MockBroker())
    }

    /// Unpairs, or leaves the demo. The saved pairing is forgotten either way.
    func unpair() {
        credentials.clear()
        pairing = nil
        clearOffice()
        phase = .unpaired
    }

    /// Drops the connection and everything read from it, so one office's
    /// threads never show under another.
    private func clearOffice() {
        eventTask?.cancel()
        eventTask = nil
        pollTask?.cancel()
        pollTask = nil
        notch = nil
        hiddenAttention = []
        broker = nil
        bots = []
        messages = [:]
        requests = []
        unread = [:]
        typing = []
        openThread = nil
        tab = .inbox
        isMock = false
    }

    func handle(url: URL) {
        if url.scheme == Pairing.scheme, url.host == "pair" {
            propose(text: url.absoluteString)
        } else if url.scheme == Pairing.scheme, url.host == "thread", let slug = url.pathComponents.dropFirst().first {
            tab = .agents
            openThread = DMChannel.slug(for: slug)
        } else if url.scheme == Pairing.scheme, url.host == "inbox" {
            tab = .inbox
        } else if url.scheme == Pairing.scheme, url.host == "agents" || url.host == "chats" {
            // "chats" is the tab's old name; links that used it keep working.
            tab = .agents
        } else if url.scheme == Pairing.scheme, url.host == "settings" {
            tab = .settings
        }
    }

    #if DEBUG
    /// `-pair-url <broker> -pair-token <token>` pairs immediately;
    /// `-tab inbox|agents|settings` starts on that tab;
    /// `-open <slug>` opens that bot's thread once the office is ready;
    /// `-send <text>` sends that text into the opened thread after it loads.
    func applyDebugLaunchArguments(_ args: [String]) {
        func value(after flag: String) -> String? {
            guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
            return args[i + 1]
        }
        if let url = value(after: "-pair-url"), let tok = value(after: "-pair-token"), let p = Pairing.make(urlString: url, token: tok) {
            pair(p)
        }
        switch value(after: "-tab") {
        case "inbox": tab = .inbox
        case "agents": tab = .agents
        case "settings": tab = .settings
        default: break
        }
        debugOpenSlug = value(after: "-open")
        debugSendText = value(after: "-send")
        if let slug = debugOpenSlug {
            tab = .agents
            openThread = DMChannel.slug(for: slug)
        }
    }
    private var debugOpenSlug: String?
    private var debugSendText: String?

    private func runDebugSendIfNeeded() {
        guard let slug = debugOpenSlug, let text = debugSendText else { return }
        debugSendText = nil
        Task {
            try? await Task.sleep(for: .milliseconds(800))
            await self.send(text, to: DMChannel.slug(for: slug))
        }
    }
    #endif

    // MARK: - Lifecycle

    private func connect(_ api: BrokerAPI) {
        broker = api
        notch = nil
        hiddenAttention = []
        phase = .connecting
        eventTask?.cancel()
        Task { await self.load() }
    }

    private func load() async {
        guard let broker else { return }
        do {
            let roster = try await broker.members()
            bots = OfficeStore.order(roster)
            for bot in bots where messages[bot.dmChannel] == nil {
                let history = try await broker.messages(channel: bot.dmChannel, sinceID: nil, limit: 60)
                messages[bot.dmChannel] = history
            }
            requests = try await broker.requests(channel: nil).filter(\.isPending)
            phase = .ready
            startEvents()
            startPolling()
            #if DEBUG
            runDebugSendIfNeeded()
            #endif
        } catch {
            phase = .failed((error as? BrokerError)?.errorDescription ?? error.localizedDescription)
        }
    }

    /// Chief of Staff first, then the rest alphabetically by name.
    static func order(_ roster: [Bot]) -> [Bot] {
        roster.sorted { a, b in
            if (a.builtIn ?? false) != (b.builtIn ?? false) { return a.builtIn ?? false }
            return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
        }
    }

    func refresh() async {
        guard let broker, phase == .ready else { return }
        if let roster = try? await broker.members() { bots = OfficeStore.order(roster) }
        for bot in bots {
            let last = messages[bot.dmChannel]?.last?.id
            if let fresh = try? await broker.messages(channel: bot.dmChannel, sinceID: last, limit: 60), !fresh.isEmpty {
                append(fresh, to: bot.dmChannel, countUnread: false)
            }
        }
        if let reqs = try? await broker.requests(channel: nil) { requests = reqs.filter(\.isPending) }
    }

    private func startEvents() {
        eventTask?.cancel()
        eventTask = Task { [weak self] in
            var backoff: Duration = .seconds(1)
            while !Task.isCancelled {
                guard let self, let broker = self.broker else { return }
                self.live = false
                for await event in broker.events() {
                    if Task.isCancelled { return }
                    self.live = true
                    backoff = .seconds(1)
                    self.apply(event)
                }
                self.live = false
                try? await Task.sleep(for: backoff)
                backoff = min(backoff * 2, .seconds(30))
                await self.refresh()
            }
        }
    }

    private func apply(_ event: BrokerEvent) {
        switch event {
        case let .message(msg):
            append([msg], to: msg.channel, countUnread: true)
            if !msg.isFromHuman { setTyping(msg.from, false) }
            if msg.kind?.contains("request") == true || msg.kind == "human_request_raised" {
                Task {
                    await self.reloadRequests()
                    await self.refreshNotch()
                }
            }
        case let .activity(act):
            setTyping(act.slug, act.isWorking)
        case .ready, .other:
            break
        }
    }

    private func reloadRequests() async {
        guard let broker else { return }
        if let reqs = try? await broker.requests(channel: nil) { requests = reqs.filter(\.isPending) }
    }

    private func append(_ fresh: [ChatMessage], to channel: String, countUnread: Bool) {
        var thread = messages[channel] ?? []
        var known = Set(thread.map(\.id))
        var added = 0
        for m in fresh where !known.contains(m.id) {
            thread.append(m)
            known.insert(m.id)
            if countUnread && !m.isFromHuman && openThread != channel { added += 1 }
        }
        messages[channel] = thread
        if added > 0 { unread[channel, default: 0] += added }
    }

    private func setTyping(_ slug: String, _ on: Bool) {
        typingTimers[slug]?.cancel()
        if on {
            typing.insert(slug)
            // A working bot that never reports idle would type forever; cap it.
            typingTimers[slug] = Task { [weak self] in
                try? await Task.sleep(for: .seconds(90))
                if !Task.isCancelled { self?.typing.remove(slug) }
            }
        } else {
            typing.remove(slug)
        }
    }

    // MARK: - Actions

    func markRead(_ channel: String) {
        unread[channel] = nil
    }

    func send(_ text: String, to channel: String) async {
        let content = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty, let broker else { return }
        do {
            let sent = try await broker.send(channel: channel, content: content)
            append([sent], to: channel, countUnread: false)
            feedback.playSound(.sent)
        } catch {
            pairingError = (error as? BrokerError)?.errorDescription ?? error.localizedDescription
        }
    }

    func answer(_ request: BotRequest, choice: InterviewOption, text: String?) async {
        guard let broker else { return }
        do {
            try await broker.answer(requestID: request.id, choiceID: choice.id, text: text)
            requests.removeAll { $0.id == request.id }
            feedback.playSound(.sent)
            await refreshNotch()
        } catch {
            pairingError = (error as? BrokerError)?.errorDescription ?? error.localizedDescription
        }
    }

    // MARK: - Inbox

    /// Questions to show, in inbox order, minus the ones just answered here.
    var inbox: [NotchAttention] {
        (notch?.sortedAttention ?? []).filter { !hiddenAttention.contains($0.id) }
    }

    var agents: [NotchAgent] { notch?.agents ?? [] }

    func agent(_ slug: String) -> NotchAgent? { notch?.agent(slug) }

    /// Called by the tab view as the scene comes and goes: poll only while
    /// the app is in front.
    func setForeground(_ active: Bool) {
        isForeground = active
        if active {
            startPolling()
        } else {
            pollTask?.cancel()
            pollTask = nil
        }
    }

    private func startPolling() {
        guard pollTask == nil, isForeground, phase == .ready else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.refreshNotch()
                try? await Task.sleep(for: OfficeStore.pollInterval)
            }
        }
    }

    /// One poll of `/notch/state`. Plays the sound for whatever changed (a
    /// new question, an approval, an agent erroring or finishing). Offices
    /// without the endpoint get an inbox built from `/requests` instead.
    func refreshNotch() async {
        guard let broker, phase == .ready else { return }
        notchSeq += 1
        let seq = notchSeq
        let fresh: NotchState
        do {
            fresh = try await broker.notchState()
        } catch {
            guard case BrokerError.http(404, _)? = error as? BrokerError else { return }
            if let reqs = try? await broker.requests(channel: nil) { requests = reqs.filter(\.isPending) }
            fresh = NotchState.derived(bots: bots, requests: requests, working: typing)
        }
        // A slower, older poll must not overwrite a newer one.
        guard seq == notchSeq else { return }
        let cues = InboxEvents.cues(from: notch, to: fresh)
        notch = fresh
        hiddenAttention.formIntersection(fresh.attention.map(\.id))
        if let cue = cues.first { feedback.play(cue) }
    }

    /// Answers an inbox card with an option (and the typed text a write-in
    /// option needs), or with free text alone when `option` is nil. The card
    /// leaves at once; it comes back if the office refuses.
    @discardableResult
    func answer(_ item: NotchAttention, option: InterviewOption?, text: String?) async -> Bool {
        guard let broker else { return false }
        withAnimation(.spring(response: 0.4, dampingFraction: 0.82)) { _ = hiddenAttention.insert(item.id) }
        do {
            if let option {
                try await broker.answer(requestID: item.id, choiceID: option.id, text: text)
            } else {
                try await broker.answer(requestID: item.id, customText: text ?? "")
            }
            requests.removeAll { $0.id == item.id }
            feedback.play(.sent)
            await refreshNotch()
            return true
        } catch {
            withAnimation(.spring(response: 0.4, dampingFraction: 0.82)) { _ = hiddenAttention.remove(item.id) }
            pairingError = (error as? BrokerError)?.errorDescription ?? error.localizedDescription
            feedback.playHaptic(.error)
            return false
        }
    }

    // MARK: - Avatars

    /// A bot's chosen look. `/notch/state` (polled every 3 s) is the fresher
    /// source, so an agent on it wins even when its avatar is nil (reset
    /// from the web); the roster covers offices without it.
    func avatar(for slug: String) -> BotAvatar? {
        if let agent = notch?.agent(slug) { return agent.avatar }
        return bots.first { $0.slug == slug }?.avatar
    }

    /// What each agent runs on, by slug, for the model badge. Rebuilt from
    /// the roster and the inbox whenever either changes.
    var runtimes: BotRuntimeLookup {
        BotRuntimeLookup(bots: bots, agents: notch?.agents ?? [])
    }

    /// Sets (or, with nil, resets) a bot's look on the office, then re-reads
    /// the roster and the inbox. Returns the office's refusal as text, or nil
    /// on success. The picker shows the error itself: an alert from the root
    /// cannot present over its sheet.
    func updateAvatar(slug: String, to avatar: BotAvatar?) async -> String? {
        guard let broker else { return "Not connected to an office." }
        do {
            try await broker.updateAvatar(slug: slug, avatar: avatar)
        } catch {
            return (error as? BrokerError)?.errorDescription ?? error.localizedDescription
        }
        // Show it at once; the reads below confirm it.
        let applied: BotAvatar? = (avatar?.isAutomatic ?? true) ? nil : avatar
        if let i = bots.firstIndex(where: { $0.slug == slug }) { bots[i].avatar = applied }
        if let i = notch?.agents.firstIndex(where: { $0.slug == slug }) { notch?.agents[i].avatar = applied }
        feedback.playHaptic(.sent)
        if let roster = try? await broker.members() { bots = OfficeStore.order(roster) }
        await refreshNotch()
        return nil
    }

    var officeAddress: String {
        if isMock { return "Demo office" }
        return pairing?.brokerURL.absoluteString ?? "Not paired"
    }

    // MARK: - Derived

    func bot(for channel: String) -> Bot? {
        bots.first { $0.dmChannel == channel }
    }

    func requests(in channel: String) -> [BotRequest] {
        requests.filter { ($0.channel ?? DMChannel.slug(for: $0.from)) == channel }
    }

    func lastMessage(_ channel: String) -> ChatMessage? {
        messages[channel]?.last
    }

    var totalUnread: Int { unread.values.reduce(0, +) }
}
