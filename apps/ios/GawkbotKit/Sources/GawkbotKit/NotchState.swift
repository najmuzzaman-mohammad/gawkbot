import Foundation

/// What an agent is doing right now, as `/notch/state` reports it. Picks the
/// avatar's animation and the inbox's mood pill. WIRE CONTRACT: the Mood*
/// constants in internal/team/broker_notch.go. An unknown value decodes as
/// `.idle` so a newer office never breaks the app.
public enum Mood: String, Codable, CaseIterable, Sendable {
    case working
    case idle
    case needsYou = "needs_you"
    case error
    case done

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Mood(rawValue: raw.lowercased()) ?? .idle
    }

    public var label: String {
        switch self {
        case .working: return "Working"
        case .idle: return "Idle"
        case .needsYou: return "Needs you"
        case .error: return "Hit a snag"
        case .done: return "Done"
        }
    }

    /// Same order the broker sorts the roster by: what needs looking at first.
    public var rank: Int {
        switch self {
        case .needsYou: return 0
        case .error: return 1
        case .working: return 2
        case .done: return 3
        case .idle: return 4
        }
    }
}

/// A short chip on an agent: who made it, or where it runs.
public struct AgentTag: Hashable, Sendable {
    public enum Style: String, Sendable {
        /// The person made it.
        case yours
        /// Office-made, adopted, or hired by another bot.
        case neutral
        /// Runs on a gateway, Slack, or a cloud computer.
        case elsewhere
    }

    public var text: String
    public var style: Style

    public init(text: String, style: Style) {
        self.text = text
        self.style = style
    }
}

/// One agent on the `/notch/state` roster.
public struct NotchAgent: Codable, Identifiable, Hashable, Sendable {
    public var slug: String
    public var name: String
    public var mood: Mood
    public var detail: String?
    /// user | chief_of_staff | bot | built_in | adopted | imported
    public var origin: String?
    /// this_machine | elsewhere
    public var runsOn: String?
    public var runsOnDetail: String?
    public var isLead: Bool
    /// The agent's chosen look, when it has one; nil is the derived look.
    public var avatar: BotAvatar?

    public var id: String { slug }

    public init(slug: String, name: String, mood: Mood, detail: String? = nil, origin: String? = nil, runsOn: String? = nil, runsOnDetail: String? = nil, isLead: Bool = false, avatar: BotAvatar? = nil) {
        self.slug = slug
        self.name = name
        self.mood = mood
        self.detail = detail
        self.origin = origin
        self.runsOn = runsOn
        self.runsOnDetail = runsOnDetail
        self.isLead = isLead
        self.avatar = avatar
    }

    enum CodingKeys: String, CodingKey {
        case slug, name, mood, detail, origin, avatar
        case runsOn = "runs_on"
        case runsOnDetail = "runs_on_detail"
        case isLead = "is_lead"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        slug = try c.decode(String.self, forKey: .slug)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? slug
        mood = try c.decodeIfPresent(Mood.self, forKey: .mood) ?? .idle
        detail = try c.decodeIfPresent(String.self, forKey: .detail)
        origin = try c.decodeIfPresent(String.self, forKey: .origin)
        runsOn = try c.decodeIfPresent(String.self, forKey: .runsOn)
        runsOnDetail = try c.decodeIfPresent(String.self, forKey: .runsOnDetail)
        isLead = try c.decodeIfPresent(Bool.self, forKey: .isLead) ?? false
        avatar = try? c.decodeIfPresent(BotAvatar.self, forKey: .avatar)
    }

    /// Cloud and gateway agents (OpenClaw, Hermes, Slack). They are answered
    /// and messaged exactly like local ones.
    public var runsElsewhere: Bool { runsOn == "elsewhere" }

    public var dmChannel: String { DMChannel.slug(for: slug) }

    /// Who made it, in the inbox's words. Nil for an origin the app does not know.
    public var originTag: AgentTag? {
        switch (origin ?? "").lowercased() {
        case "user": return AgentTag(text: "yours", style: .yours)
        case "adopted": return AgentTag(text: "adopted", style: .neutral)
        case "chief_of_staff": return AgentTag(text: "hired by CoS", style: .neutral)
        case "bot": return AgentTag(text: "hired by a bot", style: .neutral)
        case "imported": return AgentTag(text: "imported", style: .neutral)
        case "built_in": return AgentTag(text: "built in", style: .neutral)
        default: return nil
        }
    }

    /// "elsewhere · Hermes gateway". Nil for agents on the office's machine.
    public var whereTag: AgentTag? {
        guard runsElsewhere else { return nil }
        let detail = (runsOnDetail ?? "").trimmingCharacters(in: .whitespaces)
        return AgentTag(text: detail.isEmpty ? "elsewhere" : "elsewhere · \(detail)", style: .elsewhere)
    }

    /// The one chip a question card shows: where it runs when that is not
    /// here (the surprising fact), otherwise who made it.
    public var primaryTag: AgentTag? { whereTag ?? originTag }

    /// Every chip, for the roster.
    public var tags: [AgentTag] { [originTag, whereTag].compactMap { $0 } }
}

/// One thing waiting on the person: an approval or a question.
public struct NotchAttention: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var kind: String
    public var from: String
    public var fromName: String?
    public var channel: String?
    public var title: String?
    public var question: String
    public var options: [InterviewOption]
    public var recommendedID: String?
    public var blocking: Bool
    public var createdAt: String?

    public init(id: String, kind: String, from: String, fromName: String? = nil, channel: String? = nil, title: String? = nil, question: String, options: [InterviewOption] = [], recommendedID: String? = nil, blocking: Bool = false, createdAt: String? = nil) {
        self.id = id
        self.kind = kind
        self.from = from
        self.fromName = fromName
        self.channel = channel
        self.title = title
        self.question = question
        self.options = options
        self.recommendedID = recommendedID
        self.blocking = blocking
        self.createdAt = createdAt
    }

    /// The inbox card for a `/requests` row (the fallback for offices
    /// without `/notch/state`, and the mock).
    public init(request: BotRequest, fromName: String?) {
        self.init(
            id: request.id,
            kind: request.kind ?? "question",
            from: request.from,
            fromName: fromName,
            channel: request.channel,
            title: request.title,
            question: request.question,
            options: request.options ?? request.choices ?? [],
            recommendedID: request.recommendedID,
            blocking: request.blocking ?? false,
            createdAt: request.createdAt
        )
    }

    enum CodingKeys: String, CodingKey {
        case id, kind, from, channel, title, question, options, blocking
        case fromName = "from_name"
        case recommendedID = "recommended_id"
        case createdAt = "created_at"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? "question"
        from = try c.decode(String.self, forKey: .from)
        fromName = try c.decodeIfPresent(String.self, forKey: .fromName)
        channel = try c.decodeIfPresent(String.self, forKey: .channel)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        question = try c.decodeIfPresent(String.self, forKey: .question) ?? ""
        options = try c.decodeIfPresent([InterviewOption].self, forKey: .options) ?? []
        recommendedID = try c.decodeIfPresent(String.self, forKey: .recommendedID)
        blocking = try c.decodeIfPresent(Bool.self, forKey: .blocking) ?? false
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
    }

    public var displayName: String {
        let name = (fromName ?? "").trimmingCharacters(in: .whitespaces)
        return name.isEmpty ? from : name
    }

    public var isApproval: Bool {
        let k = kind.lowercased()
        return k == "approval" || k == "confirm"
    }

    public var date: Date? { createdAt.flatMap(ISO8601.parse) }

    /// The option a 1-based number key picks, if there is one.
    public func option(shortcut number: Int) -> InterviewOption? {
        guard number >= 1, number <= options.count else { return nil }
        return options[number - 1]
    }

    public var recommendedOption: InterviewOption? {
        guard let rec = recommendedID, !rec.isEmpty else { return nil }
        return options.first { $0.id == rec }
    }

    public func isRecommended(_ option: InterviewOption) -> Bool {
        guard let rec = recommendedID, !rec.isEmpty else { return false }
        return option.id == rec
    }

    /// What a leading swipe takes: the recommended option, or an
    /// "approve…" option, as long as it needs no typed text.
    public var quickOption: InterviewOption? {
        if let rec = recommendedOption, rec.requiresText != true { return rec }
        return options.first { $0.id.lowercased().hasPrefix("approve") && $0.requiresText != true }
    }
}

/// GET /notch/state: every agent's mood, what needs the person, and a
/// one-line headline. WIRE CONTRACT: internal/team/broker_notch.go.
public struct NotchState: Codable, Hashable, Sendable {
    public var lead: String?
    public var leadName: String?
    public var leadDM: String?
    public var mood: Mood
    public var headline: String
    public var agents: [NotchAgent]
    public var attention: [NotchAttention]

    public init(lead: String? = nil, leadName: String? = nil, leadDM: String? = nil, mood: Mood = .idle, headline: String = "", agents: [NotchAgent] = [], attention: [NotchAttention] = []) {
        self.lead = lead
        self.leadName = leadName
        self.leadDM = leadDM
        self.mood = mood
        self.headline = headline
        self.agents = agents
        self.attention = attention
    }

    enum CodingKeys: String, CodingKey {
        case lead, mood, headline, agents, attention
        case leadName = "lead_name"
        case leadDM = "lead_dm"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        lead = try c.decodeIfPresent(String.self, forKey: .lead)
        leadName = try c.decodeIfPresent(String.self, forKey: .leadName)
        leadDM = try c.decodeIfPresent(String.self, forKey: .leadDM)
        mood = try c.decodeIfPresent(Mood.self, forKey: .mood) ?? .idle
        headline = try c.decodeIfPresent(String.self, forKey: .headline) ?? ""
        agents = try c.decodeIfPresent([NotchAgent].self, forKey: .agents) ?? []
        attention = try c.decodeIfPresent([NotchAttention].self, forKey: .attention) ?? []
    }

    /// The Chief of Staff's DM: `lead_dm` when the office names it, else
    /// derived from `lead`.
    public var leadChannel: String? {
        if let dm = leadDM, !dm.isEmpty { return dm }
        if let lead, !lead.isEmpty { return DMChannel.slug(for: lead) }
        return nil
    }

    public func agent(_ slug: String) -> NotchAgent? {
        agents.first { $0.slug == slug }
    }

    /// The inbox order, re-applied on the phone so it holds for any office:
    /// blocking first, then oldest first, otherwise as sent.
    public var sortedAttention: [NotchAttention] { NotchState.order(attention) }

    public static func order(_ items: [NotchAttention]) -> [NotchAttention] {
        items.enumerated().sorted { a, b in
            if a.element.blocking != b.element.blocking { return a.element.blocking }
            let ca = a.element.createdAt ?? ""
            let cb = b.element.createdAt ?? ""
            if ca != cb { return ca < cb }
            return a.offset < b.offset
        }.map { $0.element }
    }

    /// Lead first, then by mood rank, otherwise as sent (the broker's order).
    public static func rankAgents(_ agents: [NotchAgent]) -> [NotchAgent] {
        agents.enumerated().sorted { a, b in
            if a.element.isLead != b.element.isLead { return a.element.isLead }
            if a.element.mood.rank != b.element.mood.rank { return a.element.mood.rank < b.element.mood.rank }
            return a.offset < b.offset
        }.map { $0.element }
    }

    /// Overall mood and headline, the same rules as the broker's
    /// notchHeadline. Used by the mock and the fallback.
    public static func summary(attention: [NotchAttention], agents: [NotchAgent]) -> (mood: Mood, headline: String) {
        if attention.count == 1, let one = attention.first {
            let what = (one.title ?? "").isEmpty ? one.question : (one.title ?? "")
            return (.needsYou, "\(one.displayName) needs you: \(what)")
        }
        if attention.count > 1 { return (.needsYou, "\(attention.count) things need you") }
        let errors = agents.filter { $0.mood == .error }.count
        if errors > 0 { return (.error, errors == 1 ? "1 bot hit a snag" : "\(errors) bots hit a snag") }
        let working = agents.filter { $0.mood == .working }.count
        if working > 0 { return (.working, working == 1 ? "1 bot working" : "\(working) bots working") }
        if agents.contains(where: { $0.mood == .done }) { return (.done, "Done. Nothing needs you.") }
        return (.idle, "All quiet. Nothing needs you.")
    }

    /// An inbox built from `/office-members` and `/requests`, for an office
    /// too old to serve `/notch/state`. No origins or where-it-runs tags;
    /// moods are only needs-you, working (typing), or idle.
    public static func derived(bots: [Bot], requests: [BotRequest], working: Set<String>) -> NotchState {
        let pending = requests.filter(\.isPending)
        let asking = Set(pending.map(\.from))
        var names: [String: String] = [:]
        for bot in bots where names[bot.slug] == nil { names[bot.slug] = bot.name }
        let lead = bots.first { $0.builtIn == true }?.slug ?? (names["cos"] != nil ? "cos" : nil)
        let agents = bots.map { bot -> NotchAgent in
            let mood: Mood = asking.contains(bot.slug) ? .needsYou : (working.contains(bot.slug) ? .working : .idle)
            return NotchAgent(
                slug: bot.slug,
                name: bot.name,
                mood: mood,
                detail: mood == .needsYou ? "waiting on you" : bot.task,
                origin: bot.builtIn == true ? "built_in" : nil,
                isLead: bot.slug == lead,
                avatar: bot.avatar
            )
        }
        let attention = order(pending.map { NotchAttention(request: $0, fromName: names[$0.from]) })
        let ranked = rankAgents(agents)
        let s = summary(attention: attention, agents: ranked)
        return NotchState(
            lead: lead,
            leadName: lead.flatMap { names[$0] },
            leadDM: lead.map { DMChannel.slug(for: $0) },
            mood: s.mood,
            headline: s.headline,
            agents: ranked,
            attention: attention
        )
    }
}
