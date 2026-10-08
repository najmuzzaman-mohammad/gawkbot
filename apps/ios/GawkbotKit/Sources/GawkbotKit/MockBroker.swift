import Foundation

/// A stand-in office for previews, screenshots, and tests. Seeded with a
/// small newsroom roster (one of them a gateway agent that runs elsewhere)
/// and three pending questions; `send` answers a few seconds later through
/// the event stream (typing first, then the reply) so the UI can be exercised
/// end to end without a broker. `/notch/state` is derived from the same
/// state, so answering a card in the inbox or in a thread clears it in both,
/// and a bot that replies goes working → done → idle.
public actor MockBroker: BrokerAPI {
    public struct Config: Sendable {
        /// Delay before the bot starts "typing" and before it replies.
        public var typingDelay: Duration
        public var replyDelay: Duration
        public init(typingDelay: Duration = .milliseconds(600), replyDelay: Duration = .seconds(2)) {
            self.typingDelay = typingDelay
            self.replyDelay = replyDelay
        }
    }

    private let config: Config
    private var bots: [Bot]
    private var store: [String: [ChatMessage]] = [:]
    private var pending: [BotRequest] = []
    private var counter = 100
    private var listeners: [UUID: AsyncStream<BrokerEvent>.Continuation] = [:]
    /// Live moods that replace a bot's seeded one, with a stamp so a stale
    /// "settle back to idle" never clears a newer mood.
    private var moods: [String: (mood: Mood, detail: String?, stamp: Int)] = [:]
    /// Chosen looks, by slug. Hermes starts with a picked shape and its
    /// derived colour, so a partial override is on show in -mock mode.
    private var avatars: [String: BotAvatar] = MockBroker.seedAvatars

    public static let seedAvatars: [String: BotAvatar] = ["hermes": BotAvatar(shape: "blob")]

    public init(config: Config = Config()) {
        self.config = config
        self.bots = MockBroker.roster
        for bot in bots {
            store[bot.dmChannel] = MockBroker.seedThread(for: bot)
        }
        pending = MockBroker.seedRequests(now: Date())
    }

    public static let roster: [Bot] = [
        Bot(slug: "cos", name: "Chief of Staff", role: "Chief of Staff", status: "idle", builtIn: true),
        Bot(slug: "designer", name: "Designer", role: "design", status: "active", task: "reviewing work packet"),
        Bot(slug: "gtm-lead", name: "GTM Lead", role: "go-to-market", status: "idle"),
        Bot(slug: "founding-engineer", name: "Founding Engineer", role: "engineering", status: "idle"),
        Bot(slug: "prospect-scout", name: "Rita Scout", role: "Outbound Prospecting Analyst", status: "idle"),
        Bot(slug: "hermes", name: "Hermes", role: "community", status: "idle"),
    ]

    /// Who made each bot, where it runs, and its resting mood. Spans every
    /// mood and the origins the inbox labels, plus one gateway agent.
    public static let notchAgents: [NotchAgent] = [
        NotchAgent(slug: "cos", name: "Chief of Staff", mood: .idle, origin: "built_in", runsOn: "this_machine", runsOnDetail: "this machine", isLead: true),
        NotchAgent(slug: "designer", name: "Designer", mood: .working, detail: "reviewing work packet", origin: "user", runsOn: "this_machine", runsOnDetail: "this machine"),
        NotchAgent(slug: "gtm-lead", name: "GTM Lead", mood: .working, detail: "scoring sponsor prospects", origin: "chief_of_staff", runsOn: "this_machine", runsOnDetail: "this machine"),
        NotchAgent(slug: "founding-engineer", name: "Founding Engineer", mood: .done, detail: "just finished", origin: "user", runsOn: "this_machine", runsOnDetail: "this machine"),
        NotchAgent(slug: "prospect-scout", name: "Rita Scout", mood: .error, detail: "looks stuck", origin: "adopted", runsOn: "this_machine", runsOnDetail: "agent CLI on this machine"),
        NotchAgent(slug: "hermes", name: "Hermes", mood: .idle, origin: "imported", runsOn: "elsewhere", runsOnDetail: "Hermes gateway"),
    ]

    public static let seedRequest = BotRequest(
        id: "request-25",
        from: "designer",
        question: "Start work on the Thursday landing page? I will scaffold, build, verify, and publish it as an app.",
        title: "Start work on Thursday landing page?",
        kind: "approval",
        status: "pending",
        channel: DMChannel.slug(for: "designer"),
        options: [
            InterviewOption(id: "approve", label: "Approve"),
            InterviewOption(id: "reject", label: "Reject"),
        ],
        recommendedID: "approve",
        blocking: true
    )

    /// The pending questions: the designer's blocking approval, a choice from
    /// the Chief of Staff with a write-in option, and an approval from the
    /// gateway agent.
    static func seedRequests(now: Date) -> [BotRequest] {
        func at(_ minutesAgo: Double) -> String { ISO8601.format(now.addingTimeInterval(-minutesAgo * 60)) }
        var designer = seedRequest
        designer.createdAt = at(12)
        let sponsor = BotRequest(
            id: "request-26",
            from: "cos",
            question: "Pigment said yes to the top slot and Linear wants it too. Who gets the hero placement on Thursday?",
            title: "Which sponsor leads Thursday?",
            kind: "interview",
            status: "pending",
            channel: DMChannel.slug(for: "cos"),
            options: [
                InterviewOption(id: "pigment", label: "Pigment"),
                InterviewOption(id: "linear", label: "Linear"),
                InterviewOption(id: "other", label: "Someone else", requiresText: true),
            ],
            recommendedID: "pigment",
            createdAt: at(6)
        )
        let recap = BotRequest(
            id: "request-27",
            from: "hermes",
            question: "The recap of Tuesday's community call is drafted: five bullets and the recording link. It goes to 312 members.",
            title: "Post the community-call recap?",
            kind: "approval",
            status: "pending",
            channel: DMChannel.slug(for: "hermes"),
            options: [
                InterviewOption(id: "approve", label: "Post it"),
                InterviewOption(id: "edit", label: "Edit first", requiresText: true),
                InterviewOption(id: "reject", label: "Hold"),
            ],
            recommendedID: "approve",
            createdAt: at(3)
        )
        return [designer, sponsor, recap]
    }

    static func seedThread(for bot: Bot) -> [ChatMessage] {
        let ch = bot.dmChannel
        let now = Date()
        func at(_ minutesAgo: Double) -> String { ISO8601.format(now.addingTimeInterval(-minutesAgo * 60)) }
        switch bot.slug {
        case "cos":
            return [
                ChatMessage(id: "m1", from: "you", channel: ch, content: "Thursday's newsletter: chase the sponsor, brief the designer, and line up the app for RSVPs.", timestamp: at(52)),
                ChatMessage(id: "m2", from: "cos", channel: ch, content: "On it. Splitting that three ways: Sponsor Chaser on the follow-up, Designer on the hero, Builder on the RSVP app.", timestamp: at(51)),
                ChatMessage(id: "m3", from: "cos", channel: ch, content: "Sponsor said yes to the Thursday slot. Designer's hero is in review.", timestamp: at(9)),
            ]
        case "designer":
            return [
                ChatMessage(id: "m4", from: "you", channel: ch, content: "Hero image for Thursday. Warm, no stock photos.", timestamp: at(40)),
                ChatMessage(id: "m5", from: "designer", channel: ch, content: "Two directions coming up. One editorial, one pixel.", timestamp: at(38)),
            ]
        case "gtm-lead":
            return [
                ChatMessage(id: "m6", from: "gtm-lead", channel: ch, content: "Three sponsor prospects scored. Pigment is a 9 and ready to send.", timestamp: at(120)),
            ]
        case "founding-engineer":
            return [
                ChatMessage(id: "m7", from: "founding-engineer", channel: ch, content: "RSVP app builds clean. Publishing to Apps now.", timestamp: at(300)),
            ]
        case "hermes":
            return [
                ChatMessage(id: "m9", from: "hermes", channel: ch, content: "Recap of Tuesday's community call is drafted. Waiting on you before it goes out.", timestamp: at(4)),
            ]
        default:
            return [
                ChatMessage(id: "m8", from: bot.slug, channel: ch, content: "Standing by.", timestamp: at(1440)),
            ]
        }
    }

    // MARK: - BrokerAPI

    public func members() async throws -> [Bot] {
        bots.map { seed in
            var bot = seed
            bot.avatar = avatars[bot.slug]
            return bot
        }
    }

    public func messages(channel: String, sinceID: String?, limit: Int) async throws -> [ChatMessage] {
        let all = store[channel] ?? []
        guard let sinceID, let idx = all.firstIndex(where: { $0.id == sinceID }) else {
            return Array(all.suffix(limit))
        }
        return Array(all[(idx + 1)...].suffix(limit))
    }

    @discardableResult
    public func send(channel: String, content: String) async throws -> ChatMessage {
        counter += 1
        let msg = ChatMessage(id: "m\(counter)", from: "you", channel: channel, content: content, timestamp: ISO8601.format(Date()))
        store[channel, default: []].append(msg)
        broadcast(.message(msg))
        if let bot = DMChannel.bot(in: channel) {
            Task { await self.reply(to: content, from: bot, in: channel) }
        }
        return msg
    }

    public func requests(channel: String?) async throws -> [BotRequest] {
        pending.filter { channel == nil || $0.channel == channel }
    }

    public func answer(requestID: String, choiceID: String, text: String?) async throws {
        guard let idx = pending.firstIndex(where: { $0.id == requestID }) else { return }
        // Same refusal as the broker: a write-in option needs the words.
        let option = pending[idx].buttons.first { $0.id == choiceID }
        if option?.requiresText == true && (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw BrokerError.http(400, "custom_text required for this response")
        }
        var req = pending.remove(at: idx)
        req.status = "answered"
        let bot = req.from
        let channel = req.channel ?? DMChannel.slug(for: bot)
        counter += 1
        let ack = ChatMessage(id: "m\(counter)", from: "you", channel: channel, content: "\(choiceID == "approve" ? "Approved" : "Answered") @\(bot)'s request.\(text.map { " \($0)" } ?? "")", kind: "system", timestamp: ISO8601.format(Date()))
        store[channel, default: []].append(ack)
        broadcast(.message(ack))
        Task { await self.reply(to: "approved", from: bot, in: channel) }
    }

    public func answer(requestID: String, customText: String) async throws {
        try await answer(requestID: requestID, choiceID: "", text: customText)
    }

    public func notchState() async throws -> NotchState {
        var names: [String: String] = [:]
        for bot in bots { names[bot.slug] = bot.name }
        let asking = Set(pending.map(\.from))
        let agents = MockBroker.notchAgents.map { seed -> NotchAgent in
            var agent = seed
            agent.avatar = avatars[agent.slug]
            if asking.contains(agent.slug) {
                agent.mood = .needsYou
                agent.detail = "waiting on you"
            } else if let live = moods[agent.slug] {
                agent.mood = live.mood
                agent.detail = live.detail
            }
            return agent
        }
        let attention = NotchState.order(pending.map { NotchAttention(request: $0, fromName: names[$0.from]) })
        let ranked = NotchState.rankAgents(agents)
        let summary = NotchState.summary(attention: attention, agents: ranked)
        return NotchState(
            lead: "cos",
            leadName: "Chief of Staff",
            leadDM: DMChannel.slug(for: "cos"),
            mood: summary.mood,
            headline: summary.headline,
            agents: ranked,
            attention: attention
        )
    }

    /// Same validation as the broker's normalizeMemberAvatar: shape must be a
    /// known id, colour must be #rrggbb, both are lower-cased, and an empty
    /// avatar resets to the derived look.
    public func updateAvatar(slug: String, avatar: BotAvatar?) async throws {
        guard bots.contains(where: { $0.slug == slug }) else {
            throw BrokerError.http(404, "member not found")
        }
        let shape = (avatar?.shape ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let color = (avatar?.color ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if shape.isEmpty && color.isEmpty {
            avatars[slug] = nil
            return
        }
        if !shape.isEmpty && BotAvatar.shapeIndex(named: shape) == nil {
            throw BrokerError.http(400, "avatar shape must be one of \(BotAvatar.shapeIDs.joined(separator: ", "))")
        }
        if !color.isEmpty && BotAvatar.normalizedColor(color) == nil {
            throw BrokerError.http(400, "avatar color must be a #rrggbb hex colour")
        }
        avatars[slug] = BotAvatar(shape: shape.isEmpty ? nil : shape, color: color.isEmpty ? nil : color)
        broadcast(.other(name: "office_changed"))
    }

    public nonisolated func events() -> AsyncStream<BrokerEvent> {
        AsyncStream { continuation in
            let id = UUID()
            Task { await self.register(id: id, continuation) }
            continuation.onTermination = { _ in Task { await self.unregister(id: id) } }
        }
    }

    // MARK: - Simulation

    private func register(id: UUID, _ c: AsyncStream<BrokerEvent>.Continuation) {
        listeners[id] = c
        c.yield(.ready)
    }

    private func unregister(id: UUID) { listeners[id] = nil }

    private func broadcast(_ event: BrokerEvent) {
        for c in listeners.values { c.yield(event) }
    }

    private func reply(to prompt: String, from bot: String, in channel: String) async {
        try? await Task.sleep(for: config.typingDelay)
        setMood(bot, .working, "drafting a reply")
        broadcast(.activity(BotActivity(slug: bot, status: "active", activity: "typing")))
        try? await Task.sleep(for: config.replyDelay)
        counter += 1
        let text = MockBroker.cannedReply(bot: bot, prompt: prompt)
        let msg = ChatMessage(id: "m\(counter)", from: bot, channel: channel, content: text, timestamp: ISO8601.format(Date()))
        store[channel, default: []].append(msg)
        let stamp = setMood(bot, .done, "just finished")
        broadcast(.activity(BotActivity(slug: bot, status: "idle", activity: "waiting for work")))
        broadcast(.message(msg))
        Task {
            try? await Task.sleep(for: .seconds(8))
            await self.settle(bot, stamp: stamp)
        }
    }

    @discardableResult
    private func setMood(_ slug: String, _ mood: Mood, _ detail: String?) -> Int {
        counter += 1
        moods[slug] = (mood: mood, detail: detail, stamp: counter)
        return counter
    }

    /// Back to idle, unless something newer has set the mood since.
    private func settle(_ slug: String, stamp: Int) async {
        guard moods[slug]?.stamp == stamp else { return }
        moods[slug] = (mood: .idle, detail: nil, stamp: stamp)
    }

    static func cannedReply(bot: String, prompt: String) -> String {
        let p = prompt.lowercased()
        if p.contains("approved") { return "Thanks. Starting now; I will post the deliverable here when it is ready." }
        if p.contains("2+2") || p.contains("2 + 2") { return "4." }
        if p.contains("there") { return "Yes, here. What do you need?" }
        switch bot {
        case "cos": return "Got it. I will scope that and hand it to the right bot; you will hear from me here when it lands."
        case "designer": return "On it. First pass in about ten minutes."
        case "gtm-lead": return "Pulling the list now. Three names by end of day."
        default: return "Done. Anything else?"
        }
    }
}
