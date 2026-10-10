import Foundation

/// A terminal session kept as a member: a Claude Code or Codex window open on
/// the Mac, shown next to the office's own agents. The office reads it; it
/// does not run it, so it cannot be messaged from the phone.
///
/// WIRE CONTRACT: `memberSessionInfo` in internal/team/
/// broker_session_agents.go, under `session` on an `/office-members` member
/// whose `origin` is "session". The helpers below are a port of
/// web/src/lib/sessionMember.ts.
public struct BotSession: Codable, Hashable, Sendable {
    /// The catalog id of what runs the session ("claude-code").
    public var tool: String?
    /// The folder it works in, and that folder's full path.
    public var project: String?
    public var cwd: String?
    /// working | your_turn | quiet; absent when the session is not running.
    public var state: String?
    public var updatedAt: String?
    /// The end of its latest reply.
    public var lastSaid: String?
    /// True while the session's window is open.
    public var live: Bool

    public init(tool: String? = nil, project: String? = nil, cwd: String? = nil, state: String? = nil, updatedAt: String? = nil, lastSaid: String? = nil, live: Bool = false) {
        self.tool = tool
        self.project = project
        self.cwd = cwd
        self.state = state
        self.updatedAt = updatedAt
        self.lastSaid = lastSaid
        self.live = live
    }

    enum CodingKeys: String, CodingKey {
        case tool, project, cwd, state, live
        case updatedAt = "updated_at"
        case lastSaid = "last_said"
    }

    /// Every field reads as unset when it is missing, null, or the wrong
    /// type. A session that does not say it is live is treated as closed.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        tool = try? c.decodeIfPresent(String.self, forKey: .tool)
        project = try? c.decodeIfPresent(String.self, forKey: .project)
        cwd = try? c.decodeIfPresent(String.self, forKey: .cwd)
        state = try? c.decodeIfPresent(String.self, forKey: .state)
        updatedAt = try? c.decodeIfPresent(String.self, forKey: .updatedAt)
        lastSaid = try? c.decodeIfPresent(String.self, forKey: .lastSaid)
        live = (try? c.decodeIfPresent(Bool.self, forKey: .live)) ?? false
    }
}

/// A session row's status. It says only what the session's own log says,
/// never the office's idle copy: a terminal session that is doing nothing
/// must not be described as doing something.
public enum SessionStatus: String, CaseIterable, Sendable {
    case working
    case yourTurn
    case quiet
    case closed

    public var label: String {
        switch self {
        case .working: return "Working"
        case .yourTurn: return "Your turn"
        case .quiet: return "Quiet"
        case .closed: return "Closed"
        }
    }
}

public enum SessionMember {
    /// The `origin` of a terminal session kept as a member.
    public static let origin = "session"

    /// Why a session member cannot be messaged, in one sentence. Shown where
    /// the composer would be; equal in meaning to sessionNotMessageableReply
    /// in internal/team/broker_session_agents.go and word for word
    /// SESSION_NOT_MESSAGEABLE on the web.
    public static let notMessageable = "This session is open in your terminal on this Mac, so it cannot be messaged from here yet."

    /// The same for a session whose window has been closed: it must not be
    /// told it is open.
    public static let notMessageableClosed = "This session is closed. It cannot be messaged from here yet."

    /// The sentence for a session. Closed only when the office says it is
    /// not live; live or unknown (nil) keeps the open wording.
    public static func notMessageable(live: Bool?) -> String {
        live == false ? notMessageableClosed : notMessageable
    }

    /// The title of the roster section that holds them.
    public static let sectionTitle = "Sessions on this Mac"

    /// The roster in two groups: the office's own agents, then the terminal
    /// sessions. Each keeps the order it came in, and a session is never
    /// mixed in with the agents.
    public static func group(_ roster: [Bot]) -> (agents: [Bot], sessions: [Bot]) {
        (roster.filter { !$0.isSession }, roster.filter(\.isSession))
    }
}

extension Bot {
    /// A terminal session kept as a member, not an agent the office runs.
    public var isSession: Bool { origin == SessionMember.origin }

    /// The folder a session works in, or "" when the broker did not say.
    public var sessionProject: String {
        (session?.project ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Closed unless the session is live; then its own state, with anything
    /// other than working or your turn reading as quiet.
    public var sessionStatus: SessionStatus {
        guard let session, session.live else { return .closed }
        switch session.state {
        case "working": return .working
        case "your_turn": return .yourTurn
        default: return .quiet
        }
    }

    public var sessionStatusLabel: String { sessionStatus.label }

    /// Why this session cannot be messaged, by whether its window is open.
    /// A member with no session object is not known to be closed.
    public var sessionNotMessageable: String {
        SessionMember.notMessageable(live: session?.live)
    }

    /// The one line under the face in an empty conversation. A terminal
    /// session cannot be messaged from here, so it must not invite a hello.
    public var emptyConversationLine: String {
        let shown = name.isEmpty ? slug : name
        return isSession
            ? "\(shown) runs in your terminal."
            : "Say hi. \(shown) answers right here, like a person would."
    }
}
