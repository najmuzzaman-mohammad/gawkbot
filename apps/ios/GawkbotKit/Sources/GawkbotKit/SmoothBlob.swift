import Foundation

/// Port of web/src/lib/blobAvatarSmooth.ts: the blob mark as a smooth
/// vector. The SAME per-slug silhouette and colour as `BlobAvatar` (same
/// FNV-1a hashing) and the SAME eye placement, traced as a curve instead of
/// filled cell by cell, so a bot looks identical on the web and the phone.
///
/// Each silhouette's per-row spans give a left and right edge at the row's
/// centre; with the flat top and bottom edges added, a closed Catmull-Rom
/// spline runs through them. The eyes are rounded rects drawn into the same
/// path; fill it even-odd and they are holes. Geometry is in the 0...16 grid;
/// the app scales it.
public enum SmoothBlob {
    public struct Point: Hashable, Sendable {
        public var x: Double
        public var y: Double
        public init(x: Double, y: Double) {
            self.x = x
            self.y = y
        }
    }

    /// One cubic Bézier from the previous point to `end`.
    public struct Segment: Hashable, Sendable {
        public var control1: Point
        public var control2: Point
        public var end: Point
    }

    public struct Eye: Hashable, Sendable {
        public var x: Double
        public var y: Double
        public var width: Double
        public var height: Double
        /// Fully rounded ends, like the web's `roundedRect`.
        public var cornerRadius: Double { min(width, height) / 2 }
    }

    public struct Mark: Hashable, Sendable {
        public var start: Point
        public var segments: [Segment]
        public var eyes: [Eye]
        public var colorHex: String
    }

    /// Outline points of a silhouette, clockwise from the top-left corner.
    public static func outline(shapeIndex: Int) -> [Point] {
        let all = BlobAvatar.silhouettes
        let shape = all[((shapeIndex % all.count) + all.count) % all.count]
        var rows: [(row: Int, from: Int, to: Int)] = []
        for (row, span) in shape.enumerated() where span.end > span.start {
            rows.append((row: row, from: span.start, to: span.end))
        }
        guard let first = rows.first, let last = rows.last else { return [] }
        var out: [Point] = []
        out.append(Point(x: Double(first.from) + 0.5, y: Double(first.row)))
        out.append(Point(x: Double(first.to) - 0.5, y: Double(first.row)))
        for r in rows {
            out.append(Point(x: Double(r.to), y: Double(r.row) + 0.5))
        }
        out.append(Point(x: Double(last.to) - 0.5, y: Double(last.row + 1)))
        out.append(Point(x: Double(last.from) + 0.5, y: Double(last.row + 1)))
        for r in rows.reversed() {
            out.append(Point(x: Double(r.from), y: Double(r.row) + 0.5))
        }
        return out
    }

    /// Drops points that sit on a straight line between their (original)
    /// neighbours — one pass, exactly like the web.
    static func simplify(_ points: [Point]) -> [Point] {
        let n = points.count
        guard n >= 4 else { return points }
        var out: [Point] = []
        for i in 0..<n {
            let a = points[(i - 1 + n) % n]
            let b = points[i]
            let c = points[(i + 1) % n]
            let cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
            if abs(cross) > 1e-6 { out.append(b) }
        }
        return out.count >= 3 ? out : points
    }

    /// Closed Catmull-Rom spline through `points`, as cubic Béziers.
    static func closedSpline(_ points: [Point], tension: Double = 0.5) -> (start: Point, segments: [Segment])? {
        let n = points.count
        guard n >= 3 else { return nil }
        let k = tension / 3
        var segments: [Segment] = []
        segments.reserveCapacity(n)
        for i in 0..<n {
            let p0 = points[(i - 1 + n) % n]
            let p1 = points[i]
            let p2 = points[(i + 1) % n]
            let p3 = points[(i + 2) % n]
            let c1 = Point(x: p1.x + (p2.x - p0.x) * k, y: p1.y + (p2.y - p0.y) * k)
            let c2 = Point(x: p2.x - (p3.x - p1.x) * k, y: p2.y - (p3.y - p1.y) * k)
            segments.append(Segment(control1: c1, control2: c2, end: p2))
        }
        return (start: points[0], segments: segments)
    }

    private struct Body: Sendable {
        let start: Point
        let segments: [Segment]
    }

    /// The eight bodies, traced once.
    private static let bodies: [Body] = (0..<BlobAvatar.silhouettes.count).map { index in
        let spline = SmoothBlob.closedSpline(SmoothBlob.simplify(SmoothBlob.outline(shapeIndex: index)))
        return Body(start: spline?.start ?? Point(x: 0, y: 0), segments: spline?.segments ?? [])
    }

    /// Eye boxes. openness is snapped to twentieths like the web, then fed to
    /// the pixel system's eye spec; smooth eyes are a touch narrower.
    public static func eyes(openness: Double) -> [Eye] {
        let o = (min(1, max(0, openness)) * 20).rounded() / 20
        let spec = BlobAvatar.eyes(openness: o)
        return [spec.leftX, spec.rightX].map { x in
            Eye(x: Double(x) + 0.1, y: Double(spec.topY), width: Double(spec.width) - 0.2, height: Double(spec.height))
        }
    }

    /// The smooth mark for `slug`, derived look. openness: 1 wide open, 0 narrowed.
    public static func mark(_ slug: String, openness: Double = 1) -> Mark {
        mark(shapeIndex: BlobAvatar.shapeIndex(slug), colorHex: BlobAvatar.colorHex(slug), openness: openness)
    }

    /// The smooth mark for `slug` wearing its chosen `avatar` (either field
    /// may be unset; see `BlobAvatar.resolve`). A nil avatar is the derived look.
    public static func mark(_ slug: String, avatar: BotAvatar?, openness: Double = 1) -> Mark {
        let look = BlobAvatar.resolve(slug: slug, avatar: avatar)
        return mark(shapeIndex: look.shapeIndex, colorHex: look.color, openness: openness)
    }

    /// One silhouette (wrapping like the web's modulo) in a given colour.
    public static func mark(shapeIndex: Int, colorHex: String, openness: Double = 1) -> Mark {
        let n = bodies.count
        let body = bodies[((shapeIndex % n) + n) % n]
        return Mark(start: body.start, segments: body.segments, eyes: eyes(openness: openness), colorHex: colorHex)
    }
}
