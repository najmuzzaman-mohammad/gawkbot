import Foundation

/// Port of web/src/lib/blobAvatar.ts: which look a bot has. Same palette,
/// same FNV-1a hashing, so a bot has the same species and colour on the
/// phone as in the office. Drawing is `OrbAvatar` (the geometry) and the
/// app's `BlobAvatarView` (the pixels).
public enum BlobAvatar {
    /// How many bodies there are: the count of `BotAvatar.shapeIDs`.
    public static var shapeCount: Int { BotAvatar.shapeIDs.count }

    /// Hex body colours, same order as the web palette (AVATAR_COLORS).
    public static let colors: [String] = [
        "#ff7a59", "#ffa53d", "#f2c94c", "#9ad44e", "#45cfa0", "#3cc3df",
        "#5aa9ff", "#7b7dff", "#b48cff", "#ff79c6", "#ff6b8b", "#8ea0b8",
    ]

    /// FNV-1a over the lowercased, trimmed slug's UTF-16 code units — the
    /// same units JavaScript's charCodeAt yields, so hashes match the web.
    public static func hash(_ slug: String) -> UInt32 {
        var h: UInt32 = 0x811c9dc5
        for unit in slug.trimmingCharacters(in: .whitespaces).lowercased().utf16 {
            h ^= UInt32(unit)
            h = h &* 0x01000193
        }
        return h
    }

    /// Shape and colour come from SEPARATE bits of the hash, so they do not
    /// correlate across a roster.
    public static func shapeIndex(_ slug: String) -> Int {
        Int(hash(slug) % UInt32(shapeCount))
    }

    public static func colorHex(_ slug: String) -> String {
        colors[Int((hash(slug) >> 8) % UInt32(colors.count))]
    }
}
