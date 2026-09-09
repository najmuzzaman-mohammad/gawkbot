import Foundation

/// The human's slug on the wire. Messages the human sends carry `from: "you"`;
/// the broker also answers with `"human"` in older rows. Both are the human.
public enum Human {
    public static let slug = "human"
    public static let senderSlugs: Set<String> = ["human", "you"]

    public static func isHuman(_ slug: String) -> Bool {
        senderSlugs.contains(slug.lowercased().trimmingCharacters(in: .whitespaces))
    }
}

/// A bot on the roster (`/members`).
public struct Bot: Codable, Identifiable, Hashable, Sendable {
    public var slug: String
    public var name: String
    public var role: String?
    public var status: String?
    /// Live activity line ("reviewing work packet"), when the broker has one.
    public var task: String?
    public var builtIn: Bool?

    public var id: String { slug }

    public init(slug: String, name: String, role: String? = nil, status: String? = nil, task: String? = nil, builtIn: Bool? = nil) {
        self.slug = slug
        self.name = name
        self.role = role
        self.status = status
        self.task = task
        self.builtIn = builtIn
    }

    enum CodingKeys: String, CodingKey {
        case slug, name, role, status, task
        case builtIn = "built_in"
    }

    /// The DM channel the human shares with this bot.
    public var dmChannel: String { DMChannel.slug(for: slug) }
}

/// One chat message (`/messages`).
public struct ChatMessage: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var from: String
    public var channel: String
    public var content: String
    public var kind: String?
    public var timestamp: String
    public var replyTo: String?
    public var threadCount: Int?

    public init(id: String, from: String, channel: String, content: String, kind: String? = nil, timestamp: String, replyTo: String? = nil, threadCount: Int? = nil) {
        self.id = id
        self.from = from
        self.channel = channel
        self.content = content
        self.kind = kind
        self.timestamp = timestamp
        self.replyTo = replyTo
        self.threadCount = threadCount
    }

    enum CodingKeys: String, CodingKey {
        case id, from, channel, content, kind, timestamp
        case replyTo = "reply_to"
        case threadCount = "thread_count"
    }

    public var isFromHuman: Bool { Human.isHuman(from) }
    public var isSystem: Bool { from == "system" || from == "office" || from == "nex" }

    public var date: Date? { ISO8601.parse(timestamp) }
}

/// One option on an interview or approval card.
public struct InterviewOption: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var label: String
    public var requiresText: Bool?

    public init(id: String, label: String, requiresText: Bool? = nil) {
        self.id = id
        self.label = label
        self.requiresText = requiresText
    }

    enum CodingKeys: String, CodingKey {
        case id, label
        case requiresText = "requires_text"
    }
}

/// A bot's ask to the human (`/requests`): an approval or an interview.
public struct BotRequest: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var from: String
    public var question: String
    public var title: String?
    public var kind: String?
    public var status: String?
    public var channel: String?
    public var options: [InterviewOption]?
    public var choices: [InterviewOption]?
    public var recommendedID: String?
    public var createdAt: String?

    public init(id: String, from: String, question: String, title: String? = nil, kind: String? = nil, status: String? = nil, channel: String? = nil, options: [InterviewOption]? = nil, recommendedID: String? = nil, createdAt: String? = nil) {
        self.id = id
        self.from = from
        self.question = question
        self.title = title
        self.kind = kind
        self.status = status
        self.channel = channel
        self.options = options
        self.choices = nil
        self.recommendedID = recommendedID
        self.createdAt = createdAt
    }

    enum CodingKeys: String, CodingKey {
        case id, from, question, title, kind, status, channel, options, choices
        case recommendedID = "recommended_id"
        case createdAt = "created_at"
    }

    /// The broker sends `options` on newer rows and `choices` on older ones.
    public var buttons: [InterviewOption] {
        let raw = (options ?? choices) ?? []
        if raw.isEmpty {
            return [
                InterviewOption(id: "approve", label: "Approve"),
                InterviewOption(id: "reject", label: "Reject"),
            ]
        }
        return raw
    }

    public var isPending: Bool {
        let s = (status ?? "pending").lowercased()
        return s == "" || s == "pending" || s == "open"
    }
}

/// Live activity for one bot (`/events` → `activity`).
public struct BotActivity: Codable, Hashable, Sendable {
    public var slug: String
    public var status: String?
    public var activity: String?
    public var detail: String?

    public init(slug: String, status: String? = nil, activity: String? = nil, detail: String? = nil) {
        self.slug = slug
        self.status = status
        self.activity = activity
        self.detail = detail
    }

    /// "typing" in iMessage terms: the bot is mid-turn.
    public var isWorking: Bool {
        let s = (status ?? "").lowercased()
        return s == "active" || s == "working" || s == "running" || s == "queued"
    }
}

/// DM slugs are the two participants sorted and joined by "__"
/// (`channel.DirectSlug` on the broker). "human" sorts among bot slugs, so
/// the human's DM with "cos" is "cos__human" and with "pm" is "human__pm".
public enum DMChannel {
    public static func slug(for botSlug: String) -> String {
        let a = Human.slug
        let b = botSlug.lowercased().trimmingCharacters(in: .whitespaces)
        return a < b ? "\(a)__\(b)" : "\(b)__\(a)"
    }

    /// The bot side of a human DM slug, or nil when the slug is not one.
    public static func bot(in channel: String) -> String? {
        let parts = channel.split(separator: "__", omittingEmptySubsequences: true).map(String.init)
        guard parts.count == 2 else { return nil }
        if Human.isHuman(parts[0]) { return parts[1] }
        if Human.isHuman(parts[1]) { return parts[0] }
        return nil
    }
}

enum ISO8601 {
    static let fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    static func parse(_ s: String) -> Date? {
        fractional.date(from: s) ?? plain.date(from: s)
    }

    static func format(_ d: Date) -> String { plain.string(from: d) }
}
