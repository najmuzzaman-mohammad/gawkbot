import Foundation

/// What a bot runs on, as the broker resolves it: `runtime` on
/// `/office-members` members and `/notch/state` agents. Every avatar reads
/// this to draw its model badge, so the phone agrees with the web app and
/// the notch without re-deriving it.
///
/// WIRE CONTRACT: `memberRuntimeInfo` in internal/team/
/// broker_member_runtime.go. The badge rules below are a port of
/// web/src/lib/botRuntime.ts, function for function, and are tested against
/// the same cases.
public struct BotRuntime: Codable, Hashable, Sendable {
    /// Effective provider kind; the install default for an unbound bot.
    public var harness: String
    /// What a person calls the tool: "Claude Code", "Gemini CLI".
    public var harnessName: String?
    /// Raw model id. Absent when nobody knows (a gateway bot, a bare CLI).
    public var model: String?
    /// Short form for a badge: "Opus 5.5".
    public var modelLabel: String?
    /// "claude" | "gpt" | "gemini", or absent for a model that is not grouped.
    public var family: String?
    /// Where the model came from: observed | binding | default.
    public var source: String?

    public init(harness: String, harnessName: String? = nil, model: String? = nil, modelLabel: String? = nil, family: String? = nil, source: String? = nil) {
        self.harness = harness
        self.harnessName = harnessName
        self.model = model
        self.modelLabel = modelLabel
        self.family = family
        self.source = source
    }

    enum CodingKeys: String, CodingKey {
        case harness, model, family, source
        case harnessName = "harness_name"
        case modelLabel = "model_label"
    }

    /// Only `harness` is required. Every other field reads as unset when it
    /// is missing, null, or the wrong type, so a newer office never costs
    /// the badge.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        harness = try c.decode(String.self, forKey: .harness)
        harnessName = try? c.decodeIfPresent(String.self, forKey: .harnessName)
        model = try? c.decodeIfPresent(String.self, forKey: .model)
        modelLabel = try? c.decodeIfPresent(String.self, forKey: .modelLabel)
        family = try? c.decodeIfPresent(String.self, forKey: .family)
        source = try? c.decodeIfPresent(String.self, forKey: .source)
    }
}

/// How much a model badge can say next to an avatar of a given size.
public enum BadgeDensity: String, CaseIterable, Sendable {
    case dot
    case code
    case word
    case full
}

extension BotRuntime {
    /// Below 16 there is no room for a legible character, so the badge is a
    /// dot. 16 to 31 fits a two-character code, 32 to 43 the first word, and
    /// 44 and up the full label.
    public static func badgeDensity(avatarSize: Double) -> BadgeDensity {
        if avatarSize < 16 { return .dot }
        if avatarSize < 32 { return .code }
        if avatarSize < 44 { return .word }
        return .full
    }

    static func words(_ text: String) -> [String] {
        text.split(whereSeparator: { $0.isWhitespace }).map(String.init)
    }

    static func firstWord(_ text: String) -> String {
        words(text).first ?? ""
    }

    /// The tool at code size: the first letters of its first two words in
    /// capitals ("Gemini CLI" is "GC"), or the first two characters of a
    /// single word as written ("exo" is "ex").
    static func initials(_ name: String) -> String {
        let parts = words(name)
        guard let first = parts.first else { return "" }
        if parts.count == 1 { return String(first.prefix(2)) }
        return (String(first.prefix(1)) + String(parts[1].prefix(1))).uppercased()
    }

    private static func isASCIILetter(_ ch: Character) -> Bool {
        ch.isASCII && ch.isLetter
    }

    private static func isASCIIDigit(_ ch: Character) -> Bool {
        ch.isASCII && ch.isNumber
    }

    /// Two characters that tell one model from another at a glance.
    ///
    /// A name-first label ("Opus 5.5", "Sonnet 4.6", "Gemini 2.5 Pro")
    /// becomes the first two letters of the name: "Op", "So", "Ge". The
    /// version digit is deliberately left out: "O5" read as "05" on a small
    /// avatar, and the digit was the same for Opus and Sonnet.
    ///
    /// A label whose first word already carries its number ("GPT-6 Astra",
    /// "o3") keeps a letter and that digit: "G6", "o3".
    public static func modelCode(_ label: String) -> String {
        let word = firstWord(label)
        let letters = String(word.prefix(while: isASCIILetter))
        let digit = word.first(where: isASCIIDigit).map(String.init) ?? ""
        if digit.isEmpty && letters.count >= 2 {
            return letters.prefix(1).uppercased() + letters.dropFirst().prefix(1).lowercased()
        }
        if !letters.isEmpty && !digit.isEmpty { return String(letters.prefix(1)) + digit }
        return String(word.prefix(2))
    }

    private static func trimmed(_ text: String?) -> String {
        (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// What a person calls the tool, falling back to the raw harness id.
    public var toolName: String {
        let name = BotRuntime.trimmed(harnessName)
        return name.isEmpty ? harness : name
    }

    /// The badge text at a density. The model when it is known, else the tool:
    ///   full "Opus 5.5", word "Opus", code "Op". A dot has no text.
    public func badgeText(_ density: BadgeDensity) -> String {
        if density == .dot { return "" }
        let label = BotRuntime.trimmed(modelLabel)
        if label.isEmpty {
            switch density {
            case .code: return BotRuntime.initials(toolName)
            case .word: return BotRuntime.firstWord(toolName)
            default: return toolName
            }
        }
        switch density {
        case .full: return label
        case .word: return BotRuntime.firstWord(label)
        default: return BotRuntime.modelCode(label)
        }
    }

    /// "Opus 5.5 in Claude Code", or "Claude Code" when the model is unknown.
    public var runtimeTitle: String {
        let label = BotRuntime.trimmed(modelLabel)
        return label.isEmpty ? toolName : "\(label) in \(toolName)"
    }

    /// The badge's accessible name: "Runs on Opus 5.5 in Claude Code".
    public var accessibilityLabel: String { "Runs on \(runtimeTitle)" }
}

/// Each avatar's runtime by slug, built once from the office roster and the
/// inbox state and handed to every avatar. `/notch/state` is polled every few
/// seconds, so its runtime wins where it has one; the roster covers an agent
/// the inbox does not list and an office whose inbox sends no runtime. An
/// empty lookup draws no badge anywhere.
public struct BotRuntimeLookup: Equatable, Sendable {
    private var bySlug: [String: BotRuntime]

    public static let none = BotRuntimeLookup()

    public init(bots: [Bot] = [], agents: [NotchAgent] = []) {
        var map: [String: BotRuntime] = [:]
        for bot in bots {
            if let runtime = bot.runtime { map[bot.slug] = runtime }
        }
        for agent in agents {
            if let runtime = agent.runtime { map[agent.slug] = runtime }
        }
        bySlug = map
    }

    public subscript(slug: String) -> BotRuntime? { bySlug[slug] }

    public var isEmpty: Bool { bySlug.isEmpty }

    /// A spoken name with what it runs on: "Designer, runs on Opus 5.5 in
    /// Claude Code". The bare name when the runtime is not known.
    public func spokenName(_ name: String, slug: String) -> String {
        guard let runtime = bySlug[slug] else { return name }
        return "\(name), runs on \(runtime.runtimeTitle)"
    }
}
