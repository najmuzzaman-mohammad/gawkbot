import Foundation

/// Port of web/src/lib/gawkAvatar.ts: a bot's character as geometry.
///
/// Every bot is a small soft creature: one rounded body with volume (lit
/// from the top left, a glossy highlight, bounce light along the bottom and
/// a contact shadow underneath), two big glossy eyes, a mouth, and a
/// signature accessory per species. The eight species share the eight shape
/// ids on the wire (`BotAvatar.shapeIDs`).
///
/// This is pure geometry in a 0...64 box, in the same drawing order as the
/// web; the app's `BlobAvatarView` paints it with SwiftUI's Canvas. Keep the
/// numbers in step with the TypeScript: the Kit tests compare a body
/// spline, the tones and the eye boxes against values from it.
public enum GawkAvatar {
    public static let view: Double = 64

    /// How the face reads. The app maps a bot's mood onto one of these.
    public enum Expression: String, CaseIterable, Hashable, Sendable {
        case calm, focus, sleepy, ask, oops, happy
    }

    public struct Point: Hashable, Sendable {
        public var x: Double
        public var y: Double
        public init(x: Double, y: Double) {
            self.x = x
            self.y = y
        }
        public init(_ x: Double, _ y: Double) {
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

    /// A run of cubic Béziers from `start`.
    public struct Curve: Hashable, Sendable {
        public var start: Point
        public var segments: [Segment]
    }

    /// One quadratic leg of a stroke.
    public struct QuadLeg: Hashable, Sendable {
        public var control: Point
        public var end: Point
    }

    /// The tones a body is painted with, from one stored colour. The lit
    /// side goes lighter and a touch warmer; the shaded side darker and a
    /// touch cooler.
    public struct Tones: Hashable, Sendable {
        public var base: String
        public var light: String
        public var dark: String
        public var deep: String
    }

    public enum Fill: Hashable, Sendable {
        case color(String)
        /// Lit-to-shaded linear gradient across the body (light, base, dark).
        case body
        /// White glow at the top left, clipped to the body.
        case sheen
        /// Bounce light along the bottom, clipped to the body.
        case bounce
        /// The contact shadow under the feet.
        case shadow
        /// A little sphere (antenna balls).
        case ball
    }

    public struct Paint: Hashable, Sendable {
        public var fill: Fill?
        public var stroke: String?
        public var strokeWidth: Double
        public var opacity: Double
        /// Clipped to the body outline (highlights, bounce light).
        public var clipToBody: Bool

        public init(fill: Fill? = nil, stroke: String? = nil, strokeWidth: Double = 2, opacity: Double = 1, clipToBody: Bool = false) {
            self.fill = fill
            self.stroke = stroke
            self.strokeWidth = strokeWidth
            self.opacity = opacity
            self.clipToBody = clipToBody
        }
    }

    public enum Geometry: Hashable, Sendable {
        case curve(Curve, closed: Bool)
        case line(Point, Point)
        case quads(start: Point, legs: [QuadLeg])
        case ellipse(center: Point, rx: Double, ry: Double, rotation: Double)
        case circle(center: Point, r: Double)
    }

    public struct Primitive: Hashable, Sendable {
        public var geometry: Geometry
        public var paint: Paint
    }

    public struct Mark: Hashable, Sendable {
        public var shapeIndex: Int
        public var shape: String
        public var color: String
        public var tones: Tones
        public var body: Curve
        /// Drawn before the body (ears, feet, antennae roots), shadow first.
        public var behind: [Primitive]
        /// Body shading, clipped to the outline.
        public var shading: [Primitive]
        /// The eye elements, separately, so the view can find them.
        public var eyes: [Primitive]
        /// Drawn after the body (bubbles, curls, the face).
        public var front: [Primitive]
    }

    /// Eyes and mouth: one deep ink for every bot.
    public static let ink = "#1d1b2e"
    static let cheek = "#ff7d9c"

    // MARK: - Bodies

    /// Control points, clockwise from the top, in the order of `BotAvatar.shapeIDs`.
    /// Feet sit on y≈57 so every species stands on the same floor.
    static let bodyPoints: [[Point]] = [
        // block
        [Point(32, 11), Point(49, 14), Point(54, 34), Point(49, 55), Point(32, 57), Point(15, 55), Point(10, 34), Point(15, 14)],
        // dome
        [Point(32, 10), Point(45, 13), Point(53, 24), Point(55, 42), Point(52, 56), Point(32, 57), Point(12, 56), Point(9, 42), Point(11, 24), Point(19, 13)],
        // drop
        [Point(32, 9), Point(38, 17), Point(47, 27), Point(53, 39), Point(51, 51), Point(42, 57), Point(22, 57), Point(13, 51), Point(11, 39), Point(17, 27), Point(26, 17)],
        // bean
        [Point(27, 12), Point(41, 10), Point(51, 16), Point(55, 30), Point(54, 45), Point(47, 55), Point(33, 58), Point(19, 56), Point(11, 47), Point(9, 33), Point(14, 21)],
        // pill
        [Point(32, 6), Point(43, 8), Point(49, 18), Point(49, 34), Point(48, 48), Point(43, 56), Point(32, 58), Point(21, 56), Point(16, 48), Point(15, 34), Point(15, 18), Point(21, 8)],
        // loaf
        [Point(32, 17), Point(47, 18), Point(57, 25), Point(60, 38), Point(57, 51), Point(47, 56), Point(32, 57), Point(17, 56), Point(7, 51), Point(4, 38), Point(7, 25), Point(17, 18)],
        // shield
        [Point(32, 10), Point(46, 11), Point(55, 19), Point(54, 35), Point(47, 49), Point(37, 57), Point(27, 57), Point(17, 49), Point(10, 35), Point(9, 19), Point(18, 11)],
        // blob
        [Point(29, 10), Point(42, 9), Point(52, 15), Point(57, 29), Point(53, 43), Point(50, 54), Point(37, 58), Point(23, 57), Point(12, 52), Point(8, 40), Point(11, 26), Point(18, 13)],
    ]

    /// Closed Catmull-Rom spline through `points`, as cubic Béziers.
    static func closedSpline(_ points: [Point], tension: Double = 0.5) -> Curve {
        let n = points.count
        let k = tension / 3
        var segments: [Segment] = []
        segments.reserveCapacity(n)
        for i in 0..<n {
            let p0 = points[(i - 1 + n) % n]
            let p1 = points[i]
            let p2 = points[(i + 1) % n]
            let p3 = points[(i + 2) % n]
            let c1 = Point(p1.x + (p2.x - p0.x) * k, p1.y + (p2.y - p0.y) * k)
            let c2 = Point(p2.x - (p3.x - p1.x) * k, p2.y - (p3.y - p1.y) * k)
            segments.append(Segment(control1: c1, control2: c2, end: p2))
        }
        return Curve(start: points[0], segments: segments)
    }

    private static let bodies: [Curve] = bodyPoints.map { closedSpline($0) }

    /// The body outline for a species index (wrapping like the web's modulo).
    public static func body(shapeIndex: Int) -> Curve {
        let n = bodies.count
        return bodies[((shapeIndex % n) + n) % n]
    }

    // MARK: - Colour

    struct HSL {
        var h: Double
        var s: Double
        var l: Double
    }

    static func hexToHSL(_ hex: String) -> HSL {
        var s = hex
        if s.hasPrefix("#") { s.removeFirst() }
        var v: UInt64 = 0
        Scanner(string: s).scanHexInt64(&v)
        let r = Double((v >> 16) & 0xff) / 255
        let g = Double((v >> 8) & 0xff) / 255
        let b = Double(v & 0xff) / 255
        let mx = max(r, g, b)
        let mn = min(r, g, b)
        let l = (mx + mn) / 2
        if mx == mn { return HSL(h: 0, s: 0, l: l) }
        let d = mx - mn
        let sat = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn)
        var h: Double
        if mx == r {
            h = ((g - b) / d + (g < b ? 6 : 0)) / 6
        } else if mx == g {
            h = ((b - r) / d + 2) / 6
        } else {
            h = ((r - g) / d + 4) / 6
        }
        return HSL(h: h * 360, s: sat, l: l)
    }

    static func hslToHex(_ c: HSL) -> String {
        let hh = (c.h.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360) / 360
        let q = c.l < 0.5 ? c.l * (1 + c.s) : c.l + c.s - c.l * c.s
        let p = 2 * c.l - q
        func f(_ t0: Double) -> Double {
            var t = t0
            if t < 0 { t += 1 }
            if t > 1 { t -= 1 }
            if t < 1 / 6 { return p + (q - p) * 6 * t }
            if t < 1 / 2 { return q }
            if t < 2 / 3 { return p + (q - p) * (2 / 3 - t) * 6 }
            return p
        }
        return BotAvatar.hex(red: f(hh + 1 / 3), green: f(hh), blue: f(hh - 1 / 3))
    }

    public static func tones(_ base: String) -> Tones {
        let c = hexToHSL(base)
        return Tones(
            base: base,
            light: hslToHex(HSL(h: c.h - 8, s: min(1, c.s * 1.05), l: c.l + (1 - c.l) * 0.34)),
            dark: hslToHex(HSL(h: c.h + 10, s: min(1, c.s * 1.08), l: c.l * 0.72)),
            deep: hslToHex(HSL(h: c.h + 14, s: min(1, c.s * 1.1), l: c.l * 0.5))
        )
    }

    // MARK: - Accessories

    static func accessory(shape: String, tones t: Tones) -> (behind: [Primitive], front: [Primitive]) {
        var behind: [Primitive] = []
        var front: [Primitive] = []
        func stroke(_ g: Geometry, _ color: String, _ width: Double) -> Primitive {
            Primitive(geometry: g, paint: Paint(stroke: color, strokeWidth: width))
        }
        func fill(_ g: Geometry, _ f: Fill, opacity: Double = 1) -> Primitive {
            Primitive(geometry: g, paint: Paint(fill: f, opacity: opacity))
        }
        switch shape {
        case "block":
            behind.append(stroke(.line(Point(32, 12), Point(32, 4)), t.dark, 2.4))
            behind.append(fill(.circle(center: Point(32, 3.6), r: 3), .ball))
        case "dome":
            behind.append(fill(.circle(center: Point(14, 15), r: 5.5), .color(t.dark)))
            behind.append(fill(.circle(center: Point(50, 15), r: 5.5), .color(t.dark)))
            behind.append(fill(.circle(center: Point(14, 15), r: 2.6), .color(t.light), opacity: 0.6))
            behind.append(fill(.circle(center: Point(50, 15), r: 2.6), .color(t.light), opacity: 0.6))
        case "drop":
            let curl = Curve(start: Point(32.5, 10), segments: [
                Segment(control1: Point(30, 5), control2: Point(33, 1), end: Point(37, 2.5)),
                Segment(control1: Point(39.5, 3.5), control2: Point(39, 7), end: Point(36.5, 7)),
            ])
            front.append(stroke(.curve(curl, closed: false), t.dark, 2.6))
        case "bean":
            let stem = Curve(start: Point(40, 12), segments: [
                Segment(control1: Point(41, 8), control2: Point(42, 6), end: Point(44, 4)),
            ])
            behind.append(stroke(.curve(stem, closed: false), t.dark, 2.2))
            behind.append(fill(.ellipse(center: Point(46.5, 3.8), rx: 4.2, ry: 2.3, rotation: -28), .color(t.light)))
        case "pill":
            behind.append(stroke(.line(Point(25, 9), Point(19, 2.5)), t.dark, 2.2))
            behind.append(stroke(.line(Point(39, 9), Point(45, 2.5)), t.dark, 2.2))
            behind.append(fill(.circle(center: Point(18.5, 2.4), r: 2.3), .ball))
            behind.append(fill(.circle(center: Point(45.5, 2.4), r: 2.3), .ball))
        case "loaf":
            behind.append(fill(.ellipse(center: Point(20, 57.5), rx: 6.5, ry: 3.4, rotation: 0), .color(t.dark)))
            behind.append(fill(.ellipse(center: Point(44, 57.5), rx: 6.5, ry: 3.4, rotation: 0), .color(t.dark)))
        case "shield":
            let left = Curve(start: Point(14, 16), segments: [
                Segment(control1: Point(11, 11), control2: Point(12, 5), end: Point(16, 5)),
                Segment(control1: Point(19.5, 5), control2: Point(21, 10), end: Point(22, 14)),
            ])
            let right = Curve(start: Point(50, 16), segments: [
                Segment(control1: Point(53, 11), control2: Point(52, 5), end: Point(48, 5)),
                Segment(control1: Point(44.5, 5), control2: Point(43, 10), end: Point(42, 14)),
            ])
            behind.append(fill(.curve(left, closed: true), .color(t.dark)))
            behind.append(fill(.curve(right, closed: true), .color(t.dark)))
        default: // blob
            front.append(stroke(.circle(center: Point(55, 9), r: 3.6), t.dark, 1.6))
            front.append(fill(.circle(center: Point(49.5, 15.5), r: 1.5), .color(t.dark)))
            front.append(fill(.circle(center: Point(56.2, 7.6), r: 1), .color("#ffffff"), opacity: 0.8))
        }
        return (behind, front)
    }

    // MARK: - Face

    static let eyeLeft = Point(24.5, 31)
    static let eyeRight = Point(39.5, 31)
    static let eyeRX = 4.6
    static let eyeRY = 5.8

    static func face(_ expression: Expression, openness: Double) -> (eyes: [Primitive], rest: [Primitive]) {
        let o = min(1, max(0, openness))
        var eyes: [Primitive] = []
        var rest: [Primitive] = []
        func inkStroke(_ g: Geometry, _ width: Double = 2.2) -> Primitive {
            Primitive(geometry: g, paint: Paint(stroke: ink, strokeWidth: width))
        }
        func quad(_ a: Point, _ c: Point, _ b: Point, _ width: Double = 2.2) -> Primitive {
            inkStroke(.quads(start: a, legs: [QuadLeg(control: c, end: b)]), width)
        }
        func openEyes(_ scale: Double) {
            // Never fully shut: a shut eye reads as broken rather than blinking.
            let ry = eyeRY * scale * max(0.18, o)
            for c in [eyeLeft, eyeRight] {
                eyes.append(Primitive(geometry: .ellipse(center: c, rx: eyeRX, ry: ry, rotation: 0), paint: Paint(fill: .color(ink))))
            }
            // The catchlight sits on the eye and is not scaled with it.
            if ry > 2.2 {
                for c in [eyeLeft, eyeRight] {
                    rest.append(Primitive(
                        geometry: .circle(center: Point(c.x - 1.4, c.y - ry * 0.38), r: 1.4),
                        paint: Paint(fill: .color("#ffffff"), opacity: 0.94)
                    ))
                }
            }
        }
        switch expression {
        case .focus:
            openEyes(0.55)
            rest.append(inkStroke(.line(Point(29, 42.5), Point(35, 42.5))))
        case .sleepy:
            openEyes(0.3)
            rest.append(quad(Point(30.5, 42.5), Point(32, 44.2), Point(33.5, 42.5)))
        case .ask:
            openEyes(1.12)
            rest.append(quad(Point(20.5, 22.5), Point(24.5, 19.5), Point(28.5, 22.5), 1.9))
            rest.append(quad(Point(35.5, 22.5), Point(39.5, 19.5), Point(43.5, 22.5), 1.9))
            rest.append(Primitive(geometry: .ellipse(center: Point(32, 43.2), rx: 2.7, ry: 3.1, rotation: 0), paint: Paint(fill: .color(ink))))
        case .oops:
            openEyes(0.9)
            rest.append(inkStroke(.line(Point(20.5, 22), Point(28.5, 24.5)), 1.9))
            rest.append(inkStroke(.line(Point(43.5, 22), Point(35.5, 24.5)), 1.9))
            rest.append(inkStroke(.quads(start: Point(27.5, 43.5), legs: [
                QuadLeg(control: Point(29.75, 41), end: Point(32, 43.5)),
                QuadLeg(control: Point(34.25, 46), end: Point(36.5, 43.5)),
            ])))
        case .happy:
            // Eyes closed in a smile: arcs instead of discs.
            for c in [eyeLeft, eyeRight] {
                eyes.append(Primitive(
                    geometry: .quads(start: Point(c.x - 4.5, c.y + 1), legs: [QuadLeg(control: Point(c.x, c.y - 5), end: Point(c.x + 4.5, c.y + 1))]),
                    paint: Paint(stroke: ink, strokeWidth: 2.5)
                ))
            }
            rest.append(quad(Point(26, 40.5), Point(32, 47.5), Point(38, 40.5), 2.4))
            rest.append(Primitive(geometry: .ellipse(center: Point(18.5, 37.5), rx: 3.6, ry: 2.2, rotation: 0), paint: Paint(fill: .color(cheek), opacity: 0.42)))
            rest.append(Primitive(geometry: .ellipse(center: Point(45.5, 37.5), rx: 3.6, ry: 2.2, rotation: 0), paint: Paint(fill: .color(cheek), opacity: 0.42)))
        case .calm:
            openEyes(1)
            rest.append(quad(Point(28, 41.5), Point(32, 45), Point(36, 41.5)))
        }
        return (eyes, rest)
    }

    // MARK: - The mark

    /// The character for `slug` wearing its chosen `avatar` (either field may
    /// be unset; see `BlobAvatar.resolve`). openness: 1 wide open, 0 narrowed;
    /// it multiplies the expression's own eye height.
    public static func mark(_ slug: String, avatar: BotAvatar? = nil, expression: Expression = .calm, openness: Double = 1) -> Mark {
        let look = BlobAvatar.resolve(slug: slug, avatar: avatar)
        return mark(shapeIndex: look.shapeIndex, colorHex: look.color, expression: expression, openness: openness)
    }

    /// One species (wrapping like the web's modulo) in a given colour.
    public static func mark(shapeIndex: Int, colorHex: String, expression: Expression = .calm, openness: Double = 1) -> Mark {
        let shape = BotAvatar.shapeID(at: shapeIndex)
        let index = BotAvatar.shapeIndex(named: shape) ?? 0
        let t = tones(colorHex)
        let acc = accessory(shape: shape, tones: t)
        let f = face(expression, openness: openness)
        let body = body(shapeIndex: index)
        let shading: [Primitive] = [
            Primitive(geometry: .curve(body, closed: true), paint: Paint(fill: .sheen, clipToBody: true)),
            Primitive(geometry: .curve(body, closed: true), paint: Paint(fill: .bounce, clipToBody: true)),
            Primitive(
                geometry: .ellipse(center: Point(23, 18.5), rx: 7.5, ry: 3.6, rotation: -26),
                paint: Paint(fill: .color("#ffffff"), opacity: 0.55, clipToBody: true)
            ),
        ]
        let shadow = Primitive(geometry: .ellipse(center: Point(32, 59.6), rx: 17, ry: 3.4, rotation: 0), paint: Paint(fill: .shadow))
        return Mark(
            shapeIndex: index,
            shape: shape,
            color: colorHex,
            tones: t,
            body: body,
            behind: [shadow] + acc.behind,
            shading: shading,
            eyes: f.eyes,
            front: acc.front + f.rest
        )
    }
}
