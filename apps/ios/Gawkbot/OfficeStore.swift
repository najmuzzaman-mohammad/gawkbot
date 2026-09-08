import Foundation
import SwiftUI
import GawkbotKit

/// The one observable the views read. Owns the broker connection, the
/// roster, per-thread messages, typing state, pending requests, and unread
/// counts. Everything mutates on the main actor.
@MainActor
final class OfficeStore: ObservableObject {
    enum Phase: Equatable {
        case unpaired
        case connecting
        case ready
        case failed(String)
    }

    @Published private(set) var phase: Phase = .unpaired
    @Published private(set) var bots: [Bot] = []
    @Published private(set) var messages: [String: [ChatMessage]] = [:]
    @Published private(set) var typing: Set<String> = []
    @Published private(set) var requests: [BotRequest] = []
    @Published private(set) var unread: [String: Int] = [:]
    @Published private(set) var live = false
    @Published var openThread: String? = nil
    @Published var pairingError: String? = nil

    let isMock: Bool
    private let credentials: CredentialStore
    private var broker: BrokerAPI?
    private var eventTask: Task<Void, Never>?
    private var typingTimers: [String: Task<Void, Never>] = [:]

    init(credentials: CredentialStore, forceMock: Bool) {
        self.credentials = credentials
        self.isMock = forceMock
        if forceMock {
            connect(MockBroker())
        } else if let pairing = credentials.load() {
            connect(BrokerClient(baseURL: pairing.brokerURL, token: pairing.token))
        }
    }

    // MARK: - Pairing

    func pair(_ pairing: Pairing) {
        credentials.save(pairing)
        pairingError = nil
        connect(BrokerClient(baseURL: pairing.brokerURL, token: pairing.token))
    }

    func pair(text: String) -> Bool {
        guard let p = Pairing.parse(text) else {
            pairingError = "That code is not a gawkbot pairing link."
            return false
        }
        pair(p)
        return true
    }

    func unpair() {
        eventTask?.cancel()
        eventTask = nil
        credentials.clear()
        broker = nil
        bots = []
        messages = [:]
        requests = []
        unread = [:]
        typing = []
        phase = .unpaired
    }

    func handle(url: URL) {
        if url.scheme == Pairing.scheme, url.host == "pair" {
            _ = pair(text: url.absoluteString)
        } else if url.scheme == Pairing.scheme, url.host == "thread", let slug = url.pathComponents.dropFirst().first {
            openThread = DMChannel.slug(for: slug)
        }
    }

    // MARK: - Lifecycle

    private func connect(_ api: BrokerAPI) {
        broker = api
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
                Task { await self.reloadRequests() }
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
        } catch {
            pairingError = (error as? BrokerError)?.errorDescription ?? error.localizedDescription
        }
    }

    func answer(_ request: BotRequest, choice: InterviewOption, text: String?) async {
        guard let broker else { return }
        do {
            try await broker.answer(requestID: request.id, choiceID: choice.id, text: text)
            requests.removeAll { $0.id == request.id }
        } catch {
            pairingError = (error as? BrokerError)?.errorDescription ?? error.localizedDescription
        }
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
