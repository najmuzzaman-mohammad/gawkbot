import Foundation

/// Port of web/src/lib/blobAvatar.ts. Same silhouettes, same palette, same
/// FNV-1a hashing, so a bot has the same mark on the phone as in the office.
/// Geometry only; drawing is the app's job (SwiftUI Canvas).
public enum BlobAvatar {
    public static let grid = 16

    /// [start, end) column spans per row, 16 rows.
    public typealias Span = (start: Int, end: Int)

    static let empty: Span = (0, 0)

    static let block: [Span] = [
        empty, empty, (4, 12), (3, 13), (2, 14), (2, 14), (1, 15), (1, 15),
        (1, 15), (1, 15), (1, 15), (2, 14), (2, 14), (3, 13), empty, empty,
    ]
    static let dome: [Span] = [
        empty, (6, 10), (4, 12), (3, 13), (2, 14), (2, 14), (1, 15), (1, 15),
        (1, 15), (1, 15), (1, 15), (1, 15), (1, 15), (1, 15), (1, 15), empty,
    ]
    static let drop: [Span] = [
        empty, (7, 9), (6, 10), (6, 10), (5, 11), (4, 12), (3, 13), (2, 14),
        (2, 14), (1, 15), (1, 15), (1, 15), (2, 14), (3, 13), (5, 11), empty,
    ]
    static let bean: [Span] = [
        empty, empty, (3, 6), (2, 7), (2, 14), (1, 15), (1, 15), (1, 15),
        (1, 15), (1, 15), (1, 15), (2, 14), (2, 14), (4, 12), empty, empty,
    ]
    static let pill: [Span] = [
        (5, 11), (4, 12), (3, 13), (3, 13), (3, 13), (3, 13), (3, 13), (3, 13),
        (3, 13), (3, 13), (3, 13), (3, 13), (3, 13), (3, 13), (4, 12), (5, 11),
    ]
    static let loaf: [Span] = [
        empty, empty, empty, (3, 13), (1, 15), (0, 16), (0, 16), (0, 16),
        (0, 16), (0, 16), (0, 16), (1, 15), (2, 14), empty, empty, empty,
    ]
    static let shield: [Span] = [
        empty, (3, 13), (2, 14), (1, 15), (1, 15), (1, 15), (1, 15), (1, 15),
        (2, 14), (2, 14), (3, 13), (4, 12), (5, 11), (6, 10), (7, 9), empty,
    ]
    static let blob: [Span] = [
        empty, (5, 10), (3, 12), (2, 13), (2, 14), (1, 14), (1, 15), (1, 15),
        (1, 15), (1, 15), (2, 15), (2, 14), (3, 14), (4, 12), (6, 10), empty,
    ]

    public static let silhouettes: [[Span]] = [block, dome, drop, bean, pill, loaf, shield, blob]

    /// Hex body colours, same order as the web palette.
    public static let colors: [String] = [
        "#8a7a2e", "#6b7fd7", "#b3702f", "#3f9c8f", "#a8546b", "#6f8f43",
        "#8b6bb1", "#c08a3e", "#4d8bb8", "#a35a45", "#5f9e6b", "#9a6f9c",
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

    public static func shapeIndex(_ slug: String) -> Int {
        Int(hash(slug) % UInt32(silhouettes.count))
    }

    public static func colorHex(_ slug: String) -> String {
        colors[Int((hash(slug) >> 8) % UInt32(colors.count))]
    }

    public static func silhouette(_ slug: String) -> [Span] {
        silhouettes[shapeIndex(slug)]
    }

    /// Eye geometry in grid cells. openness 1 = wide, 0 = narrowed (never shut).
    public struct Eyes: Equatable {
        public var leftX: Int
        public var rightX: Int
        public var topY: Int
        public var width: Int
        public var height: Int
    }

    public static func eyes(openness: Double) -> Eyes {
        let o = min(1, max(0, openness))
        let height = max(2, Int((2 + o * 2).rounded()))
        return Eyes(leftX: 5, rightX: 9, topY: 5, width: 2, height: height)
    }

    /// Cells filled by the body minus the eye holes, as (x, y) pairs.
    public static func cells(_ slug: String, openness: Double = 1) -> [(x: Int, y: Int)] {
        let body = silhouette(slug)
        let e = eyes(openness: openness)
        var out: [(Int, Int)] = []
        for (y, span) in body.enumerated() {
            guard span.end > span.start else { continue }
            for x in span.start..<span.end {
                let inEyeRow = y >= e.topY && y < e.topY + e.height
                let inLeft = x >= e.leftX && x < e.leftX + e.width
                let inRight = x >= e.rightX && x < e.rightX + e.width
                if inEyeRow && (inLeft || inRight) { continue }
                out.append((x, y))
            }
        }
        return out
    }
}
