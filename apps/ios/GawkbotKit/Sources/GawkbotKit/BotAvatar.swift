import Foundation

/// A bot's chosen look on the wire: `avatar: {shape, color}` on
/// `/office-members` members and `/notch/state` agents. Both fields are
/// optional, and an unset or unknown one falls back to the value derived from
/// the slug (`BlobAvatar.shapeIndex` / `BlobAvatar.colorHex`), so a bot nobody
/// has dressed looks exactly as it always did.
///
/// WIRE CONTRACT: `MemberAvatar` in internal/team/broker_member_avatar.go.
/// `shape` is one of `shapeIDs` (indices 0–7 of `BlobAvatar.silhouettes`, in
/// that order); `color` is `#rrggbb`. Update with
/// `POST /office-members {action:"update", slug, avatar}`; `avatar: {}` resets.
public struct BotAvatar: Codable, Hashable, Sendable {
    public var shape: String?
    public var color: String?

    public init(shape: String? = nil, color: String? = nil) {
        self.shape = shape
        self.color = color
    }

    /// The silhouette ids, in the order of `BlobAvatar.silhouettes`.
    public static let shapeIDs: [String] = ["block", "dome", "drop", "bean", "pill", "loaf", "shield", "blob"]

    enum CodingKeys: String, CodingKey {
        case shape, color
    }

    /// Tolerant: a field of the wrong type reads as unset rather than
    /// failing the whole roster.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        shape = try? c.decodeIfPresent(String.self, forKey: .shape)
        color = try? c.decodeIfPresent(String.self, forKey: .color)
    }

    /// The override's silhouette index, nil when unset or not a known id.
    public var shapeIndex: Int? { BotAvatar.shapeIndex(named: shape) }

    /// The override's colour as lower-case `#rrggbb`, nil when unset or invalid.
    public var colorHex: String? { BotAvatar.normalizedColor(color) }

    /// Nothing usable is set: the bot wears its derived look.
    public var isAutomatic: Bool { shapeIndex == nil && colorHex == nil }

    /// The `avatar` object to POST: only the valid fields, normalised the
    /// way the broker normalises them. `[:]` (sent as `{}`) resets.
    public var wireBody: [String: String] {
        var out: [String: String] = [:]
        if let i = shapeIndex { out["shape"] = BotAvatar.shapeIDs[i] }
        if let c = colorHex { out["color"] = c }
        return out
    }

    /// The index of a shape id (trimmed, case-insensitive), or nil.
    public static func shapeIndex(named raw: String?) -> Int? {
        guard let raw else { return nil }
        let id = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !id.isEmpty else { return nil }
        return shapeIDs.firstIndex(of: id)
    }

    /// The shape id for an index, wrapping like the silhouette table does.
    public static func shapeID(at index: Int) -> String {
        let n = shapeIDs.count
        return shapeIDs[((index % n) + n) % n]
    }

    private static let hexDigits = Set("0123456789abcdef")

    /// `#rrggbb` in lower case, or nil for anything else (no shorthand, no
    /// alpha, no names), matching the broker's `^#[0-9a-fA-F]{6}$`.
    public static func normalizedColor(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard s.count == 7, s.first == "#", s.dropFirst().allSatisfy({ hexDigits.contains($0) }) else { return nil }
        return s
    }

    /// `#rrggbb` for sRGB components in 0...1. Out-of-range (an extended or
    /// wide-gamut colour) and non-finite components are clamped.
    public static func hex(red: Double, green: Double, blue: Double) -> String {
        func byte(_ v: Double) -> String {
            let x = v.isFinite ? min(1, max(0, v)) : 0
            let s = String(Int((x * 255).rounded()), radix: 16)
            return s.count < 2 ? "0" + s : s
        }
        return "#" + byte(red) + byte(green) + byte(blue)
    }
}

extension BlobAvatar {
    /// The silhouette and colour a bot is drawn with: its chosen avatar's
    /// fields where they are set and valid, otherwise the slug-derived ones.
    /// With no avatar this is exactly `(shapeIndex(slug), colorHex(slug))`.
    public static func resolve(slug: String, avatar: BotAvatar?) -> (shapeIndex: Int, color: String) {
        (avatar?.shapeIndex ?? shapeIndex(slug), avatar?.colorHex ?? colorHex(slug))
    }
}
