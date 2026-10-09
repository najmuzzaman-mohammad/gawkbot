import Foundation

// MARK: - Hardware keyboard

/// What a key does in the inbox.
public enum InboxCommand: Hashable, Sendable {
    case next
    case previous
    /// 1-based option number on the selected question.
    case pick(Int)
    case takeRecommended
    case reply
    case cancel
}

/// A key as the inbox sees it, independent of SwiftUI's KeyEquivalent.
public enum InboxKey: Hashable, Sendable {
    case character(Character)
    case upArrow
    case downArrow
    case returnKey
    case escape
}

public struct KeyModifiers: OptionSet, Hashable, Sendable {
    public let rawValue: Int
    public init(rawValue: Int) { self.rawValue = rawValue }

    public static let command = KeyModifiers(rawValue: 1 << 0)
    public static let shift = KeyModifiers(rawValue: 1 << 1)
    public static let option = KeyModifiers(rawValue: 1 << 2)
    public static let control = KeyModifiers(rawValue: 1 << 3)
}

public struct InboxBinding: Identifiable, Hashable, Sendable {
    public let key: InboxKey
    public let command: InboxCommand
    /// Shown in the iPad shortcut overlay and the Settings list.
    public let title: String

    public var id: String { "\(key)-\(title)" }

    public init(key: InboxKey, command: InboxCommand, title: String) {
        self.key = key
        self.command = command
        self.title = title
    }
}

/// One line of the shortcut reference in Settings.
public struct ShortcutHelp: Identifiable, Hashable, Sendable {
    public let keys: String
    public let action: String
    public var id: String { keys }
}

/// The inbox's hardware-keyboard map. Pure, so it is unit-tested and the
/// app only turns each binding into a `.keyboardShortcut`.
///
/// Every binding is a bare key. Any modifier means "not ours": ⌘V stays
/// paste, ⌘R and friends stay the system's, so the map never steals a
/// standard shortcut.
public enum InboxKeymap {
    public static func command(for key: InboxKey, modifiers: KeyModifiers = []) -> InboxCommand? {
        guard modifiers.isEmpty else { return nil }
        switch key {
        case .downArrow: return .next
        case .upArrow: return .previous
        case .returnKey: return .takeRecommended
        case .escape: return .cancel
        case let .character(ch):
            let s = String(ch).lowercased()
            switch s {
            case "j": return .next
            case "k": return .previous
            case "r": return .reply
            default:
                if let n = Int(s), (1...9).contains(n) { return .pick(n) }
                return nil
            }
        }
    }

    public static let bindings: [InboxBinding] = {
        var out: [InboxBinding] = [
            InboxBinding(key: .character("j"), command: .next, title: "Next question"),
            InboxBinding(key: .downArrow, command: .next, title: "Next question"),
            InboxBinding(key: .character("k"), command: .previous, title: "Previous question"),
            InboxBinding(key: .upArrow, command: .previous, title: "Previous question"),
        ]
        for n in 1...9 {
            let ch = Character(String(n))
            out.append(InboxBinding(key: .character(ch), command: .pick(n), title: "Pick option \(n)"))
        }
        out.append(InboxBinding(key: .returnKey, command: .takeRecommended, title: "Take recommended"))
        out.append(InboxBinding(key: .character("r"), command: .reply, title: "Reply"))
        out.append(InboxBinding(key: .escape, command: .cancel, title: "Cancel"))
        return out
    }()

    public static let help: [ShortcutHelp] = [
        ShortcutHelp(keys: "J or ↓", action: "Next question"),
        ShortcutHelp(keys: "K or ↑", action: "Previous question"),
        ShortcutHelp(keys: "1 – 9", action: "Pick that option"),
        ShortcutHelp(keys: "Return", action: "Take the recommended option"),
        ShortcutHelp(keys: "R", action: "Reply in your own words"),
        ShortcutHelp(keys: "Esc", action: "Clear the selection"),
    ]
}

// MARK: - Selection

/// Moving the selection by id, so a poll that reorders or removes cards
/// never makes the highlight jump to a different question.
public enum InboxCursor {
    /// With nothing selected, "next" lands on the first card and "previous"
    /// on the last. Movement stops at the ends rather than wrapping.
    public static func move(from selected: String?, in ids: [String], by delta: Int) -> String? {
        guard !ids.isEmpty else { return nil }
        guard let selected, let i = ids.firstIndex(of: selected) else {
            return delta < 0 ? ids.last : ids.first
        }
        let j = min(max(i + delta, 0), ids.count - 1)
        return ids[j]
    }

    /// After a refresh: keep the selection if it is still there; if it was
    /// answered, select whatever now sits in its place.
    public static func reconcile(selected: String?, previous: [String], current: [String]) -> String? {
        guard let selected else { return nil }
        if current.contains(selected) { return selected }
        guard !current.isEmpty else { return nil }
        let i = previous.firstIndex(of: selected) ?? 0
        return current[min(i, current.count - 1)]
    }
}

// MARK: - Event sounds

/// Which sounds a fresh poll deserves, most important first. Nothing on the
/// first poll (opening the app should not fanfare the backlog).
public enum InboxEvents {
    public static func cues(from old: NotchState?, to new: NotchState) -> [SoundCue] {
        guard let old else { return [] }
        var cues = Set<SoundCue>()
        let known = Set(old.attention.map(\.id))
        for item in new.attention where !known.contains(item.id) {
            cues.insert(item.isApproval ? .approvalNeeded : .newQuestion)
        }
        var before: [String: Mood] = [:]
        for agent in old.agents { before[agent.slug] = agent.mood }
        for agent in new.agents {
            guard let was = before[agent.slug], was != agent.mood else { continue }
            if agent.mood == .error { cues.insert(.error) }
            if agent.mood == .done { cues.insert(.done) }
        }
        return cues.sorted { $0.priority < $1.priority }
    }
}
