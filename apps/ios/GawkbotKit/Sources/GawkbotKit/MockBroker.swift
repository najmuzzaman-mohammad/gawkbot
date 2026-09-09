import Foundation

/// A stand-in office for previews, screenshots, and tests. Seeded with a
/// small newsroom roster; `send` answers a few seconds later through the
/// event stream (typing first, then the reply) so the UI can be exercised
/// end to end without a broker.
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

    public init(config: Config = Config()) {
        self.config = config
        self.bots = MockBroker.roster
        for bot in bots {
            store[bot.dmChannel] = MockBroker.seedThread(for: bot)
        }
        pending = [MockBroker.seedRequest]
    }

    public static let roster: [Bot] = [
        Bot(slug: "cos", name: "Chief of Staff", role: "Chief of Staff", status: "idle", builtIn: true),
        Bot(slug: "designer", name: "Designer", role: "design", status: "active", task: "reviewing work packet"),
        Bot(slug: "gtm-lead", name: "GTM Lead", role: "go-to-market", status: "idle"),
        Bot(slug: "founding-engineer", name: "Founding Engineer", role: "engineering", status: "idle"),
        Bot(slug: "prospect-scout", name: "Rita Scout", role: "Outbound Prospecting Analyst", status: "idle"),
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
        recommendedID: "approve"
    )

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
        default:
            return [
                ChatMessage(id: "m8", from: bot.slug, channel: ch, content: "Standing by.", timestamp: at(1440)),
            ]
        }
    }

    // MARK: - BrokerAPI

    public func members() async throws -> [Bot] { bots }

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
        broadcast(.activity(BotActivity(slug: bot, status: "active", activity: "typing")))
        try? await Task.sleep(for: config.replyDelay)
        counter += 1
        let text = MockBroker.cannedReply(bot: bot, prompt: prompt)
        let msg = ChatMessage(id: "m\(counter)", from: bot, channel: channel, content: text, timestamp: ISO8601.format(Date()))
        store[channel, default: []].append(msg)
        broadcast(.activity(BotActivity(slug: bot, status: "idle", activity: "waiting for work")))
        broadcast(.message(msg))
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
