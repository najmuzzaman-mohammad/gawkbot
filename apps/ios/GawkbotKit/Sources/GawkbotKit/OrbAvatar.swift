import Foundation

/// A bot's character as geometry: ported from orb-mascot core.js (MIT), the
/// still frame only (no gaze, no idle loop; the phone's motion is
/// `MoodMotion`, applied by the view on top of the still).
///
/// An orb is a "composed body": a union of circles and ellipses filleted
/// into one blob by a goo filter (blur, then an alpha threshold), two eyes
/// and a mouth that sit on a spheroid inside it, and a light and a shadow
/// tint over the flat colour, clipped to the body. The eight bodies share
/// the eight shape ids on the wire (`BotAvatar.shapeIDs`).
///
/// Everything here is in the mascot's viewBox (`-24 -24 248 248`: centre
/// (100, 100), sphere radius 96, y down); the app's `BlobAvatarView` paints
/// a `Mark` with SwiftUI's Canvas. Keep the numbers in step with core.js:
/// the Kit tests check fits, eye centres and tints against values from it.
public enum OrbAvatar {
    // MARK: - Canvas

    /// The viewBox is `viewOrigin` to `viewOrigin + view` on both axes.
    public static let view: Double = 248
    public static let viewOrigin: Double = -24
    /// The body's centre and the nominal sphere radius, in viewBox units.
    public static let center: Double = 100
    public static let radius: Double = 96

    /// Composed bodies are scaled so their rest silhouette reaches this
    /// extent (in units of the radius); the cloud is the one that overrides it.
    static let fitTarget: Double = 0.95
    /// Fillet amount for the goo: `stdDeviation = 1 + round * 13`.
    public static let round: Double = 0.5
    /// The goo's Gaussian blur, in viewBox units (7.5).
    public static let blurStdDeviation: Double = 1 + round * 13
    /// The goo's alpha threshold: `alpha' = 24 * alpha - 11` is positive
    /// above this.
    public static let alphaThreshold: Double = 11.0 / 24.0

    /// Degrees each eye sits from the centre meridian / above the equator.
    static let eyeLon: Double = 16
    static let eyeLat: Double = 4
    /// Eye box in viewBox units; `corner` 1 is fully rounded (a circle).
    static let eyeW: Double = 22
    static let eyeH: Double = 22
    static let corner: Double = 1
    /// The default mouth: -1 frown … 0 flat … 1 smile; stroke in viewBox
    /// units; degrees below the eye line.
    public static let mouthCurve: Double = 0.4
    static let mouthStroke: Double = 6
    static let mouthDrop: Double = 22

    /// Eye and mouth colours: white on dark bodies, ink on light ones.
    public static let ink = "#141416"
    public static let white = "#ffffff"
    /// Relative luminance above which the face is drawn in ink.
    public static let inkLuminance: Double = 0.55

    // MARK: - Geometry types

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

    /// An SVG `matrix(a b c d tx ty)`: x' = a·x + c·y + tx, y' = b·x + d·y + ty.
    public struct Transform: Hashable, Sendable {
        public var a: Double
        public var b: Double
        public var c: Double
        public var d: Double
        public var tx: Double
        public var ty: Double

        public init(a: Double, b: Double, c: Double, d: Double, tx: Double, ty: Double) {
            self.a = a
            self.b = b
            self.c = c
            self.d = d
            self.tx = tx
            self.ty = ty
        }

        public static let identity = Transform(a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0)

        public func apply(_ p: Point) -> Point {
            Point(a * p.x + c * p.y + tx, b * p.x + d * p.y + ty)
        }

        /// `self · translate(x, y)`: the translation happens first, in the
        /// local plane, then this transform.
        public func translated(x: Double, y: Double) -> Transform {
            Transform(a: a, b: b, c: c, d: d, tx: tx + a * x + c * y, ty: ty + b * x + d * y)
        }
    }

    /// One circle or ellipse of a body. Before fitting the numbers are
    /// fractions of the radius about (0, 0); in a `Mark` they are viewBox
    /// units. `angle` is degrees, clockwise on screen (y down).
    public struct Piece: Hashable, Sendable {
        public var x: Double
        public var y: Double
        public var rx: Double
        public var ry: Double
        public var angle: Double

        public init(x: Double, y: Double, rx: Double, ry: Double, angle: Double = 0) {
            self.x = x
            self.y = y
            self.rx = rx
            self.ry = ry
            self.angle = angle
        }

        public static func circle(_ x: Double, _ y: Double, _ r: Double) -> Piece {
            Piece(x: x, y: y, rx: r, ry: r, angle: 0)
        }

        public static func ellipse(_ x: Double, _ y: Double, _ rx: Double, _ ry: Double, _ angle: Double = 0) -> Piece {
            Piece(x: x, y: y, rx: rx, ry: ry, angle: angle)
        }

        public var isCircle: Bool { rx == ry }

        /// How far the piece reaches from the centre on either axis
        /// (core.js `extentOf`, one piece).
        var extent: Double {
            if isCircle { return max(abs(x), abs(y)) + rx }
            let a = angle * .pi / 180
            let c = cos(a), s = sin(a)
            let ex = hypot(rx * c, ry * s)
            let ey = hypot(rx * s, ry * c)
            return max(abs(x) + ex, abs(y) + ey)
        }
    }

    /// The spheroid the face sits on: centre offset and radii, in units of
    /// the radius (scaled by the fit in a `Mark`).
    public struct Surf: Hashable, Sendable {
        public var cx: Double
        public var cy: Double
        public var rx: Double
        public var ry: Double

        public init(cx: Double = 0, cy: Double = 0, rx: Double, ry: Double) {
            self.cx = cx
            self.cy = cy
            self.rx = rx
            self.ry = ry
        }

        func scaled(_ k: Double) -> Surf {
            Surf(cx: cx * k, cy: cy * k, rx: rx * k, ry: ry * k)
        }
    }

    // MARK: - Bodies

    /// The eight composed bodies, in the order of `BotAvatar.shapeIDs`
    /// (core.js `COMPOSED`, at rest).
    public enum Body: String, CaseIterable, Hashable, Sendable {
        case bear, lemon, ghost, cloud, drop, stack, seacow, flower

        /// The rest pieces, in units of the radius about (0, 0).
        public var pieces: [Piece] {
            switch self {
            case .bear:
                return [.circle(0, 0.05, 0.9), .circle(-0.6, -0.62, 0.32), .circle(0.6, -0.62, 0.32)]
            case .lemon:
                return [.circle(0, 0, 0.84), .circle(0, -0.72, 0.3), .circle(0, 0.72, 0.3)]
            case .ghost:
                return [.circle(0, -0.12, 0.84), .circle(-0.48, 0.62, 0.3), .circle(0, 0.7, 0.3), .circle(0.48, 0.62, 0.3)]
            case .cloud:
                // Two pills crossed.
                return [.ellipse(0, 0, 0.94, 0.5, -45), .ellipse(0, 0, 0.94, 0.5, 45)]
            case .drop:
                return [.circle(0, 0.12, 0.84), .circle(0, -0.7, 0.26)]
            case .stack:
                // A hidden core under two flat ellipses.
                return [.circle(0, 0, 0.55), .ellipse(0, -0.36, 0.86, 0.52), .ellipse(0, 0.36, 0.86, 0.52)]
            case .seacow:
                // Like the bear, flipped: feet at the bottom corners.
                return [.circle(0, -0.06, 0.86), .circle(-0.62, 0.6, 0.32), .circle(0.62, 0.6, 0.32)]
            case .flower:
                var out: [Piece] = [.circle(0, 0, 0.8)]
                for i in 0..<8 {
                    let a = Double(i) * .pi / 4 + .pi / 8
                    out.append(.circle(0.62 * cos(a), 0.62 * sin(a), 0.33))
                }
                return out
            }
        }

        /// Radius of the inner sphere the eyes ride on, in units of the radius.
        public var sphereR: Double {
            switch self {
            case .bear: return 0.88
            case .lemon: return 0.84
            case .ghost: return 0.84
            case .cloud: return 0.86
            case .drop: return 0.84
            case .stack: return 0.84
            case .seacow: return 0.86
            case .flower: return 0.86
            }
        }

        /// The face spheroid, with the fields a body leaves unset defaulting
        /// to a sphere of `sphereR` at the centre.
        public var surf: Surf {
            let r = sphereR
            switch self {
            case .bear: return Surf(cy: 0.05, rx: r, ry: r)
            case .lemon: return Surf(rx: 0.84, ry: 0.98)
            case .ghost: return Surf(cy: -0.12, rx: r, ry: r)
            case .cloud: return Surf(rx: r, ry: r)
            case .drop: return Surf(cy: 0.12, rx: r, ry: r)
            case .stack: return Surf(rx: 0.9, ry: 0.8)
            case .seacow: return Surf(cy: -0.06, rx: r, ry: r)
            case .flower: return Surf(rx: r, ry: r)
            }
        }

        /// The extent the fitted silhouette reaches, in units of the radius.
        public var fitTarget: Double {
            self == .cloud ? 0.86 : OrbAvatar.fitTarget
        }

        /// How far the rest silhouette reaches (core.js `extentOf`).
        public var extent: Double {
            pieces.map(\.extent).max() ?? 1
        }

        /// The scale that brings the rest silhouette to `fitTarget`
        /// (core.js `fitOf`).
        public var fit: Double {
            fitTarget / extent
        }
    }

    // MARK: - Face

    /// The live face values as one still pose. The app maps a bot's mood
    /// onto one of the named stills; `blink` (0 open … 1 shut) comes from
    /// the motion.
    public struct Face: Hashable, Sendable {
        /// Scales the whole eye (and the mouth's width and stroke).
        public var eyeScale: Double
        /// Scales the eye height only.
        public var squash: Double
        /// The mouth curve, -1 frown … 1 smile; nil follows the default (0.4).
        public var mouth: Double?
        /// Scales the mouth's width.
        public var mouthLen: Double
        /// How shut the eyes are, 0 open … 1 shut.
        public var blink: Double

        public init(eyeScale: Double = 1, squash: Double = 1, mouth: Double? = nil, mouthLen: Double = 1, blink: Double = 0) {
            self.eyeScale = eyeScale
            self.squash = squash
            self.mouth = mouth
            self.mouthLen = mouthLen
            self.blink = blink
        }

        public static let calm = Face()
        public static let working = Face(squash: 0.7, mouth: 0.15)
        public static let sleepy = Face(squash: 0.4, mouth: 0.2)
        public static let asking = Face(eyeScale: 1.15, mouth: 0.1, mouthLen: 0.6)
        public static let oops = Face(squash: 0.82, mouth: -0.6)
        public static let happy = Face(squash: 0.85, mouth: 0.9)

        /// The named stills, for tests and previews.
        public static let stills: [Face] = [.calm, .working, .sleepy, .asking, .oops, .happy]
    }

    /// One eye: a disc of radii (`rx`, `ry`) in its own plane, mapped onto
    /// the canvas by `transform` (the tangent frame on the face spheroid,
    /// with the blink's small downward shift folded in).
    public struct Eye: Hashable, Sendable {
        public var transform: Transform
        public var rx: Double
        public var ry: Double

        /// Where the eye's centre lands, in viewBox units.
        public var center: Point { transform.apply(Point(0, 0)) }
    }

    /// The mouth: in its own plane the quadratic `M -hw 0 Q 0 bulge hw 0`,
    /// stroked `strokeWidth` wide with round caps, mapped onto the canvas by
    /// `transform` (the stroke is transformed too, as SVG does).
    public struct Mouth: Hashable, Sendable {
        public var transform: Transform
        public var halfWidth: Double
        /// The control point's y; positive bulges down on screen (a smile).
        public var bulge: Double
        public var strokeWidth: Double

        public var start: Point { transform.apply(Point(-halfWidth, 0)) }
        public var control: Point { transform.apply(Point(0, bulge)) }
        public var end: Point { transform.apply(Point(halfWidth, 0)) }
    }

    /// The two tint layers over the flat colour, both clipped to the body
    /// and faded by a radial mask about `center` of `radius`: the light is
    /// opaque at the centre and gone by `fade` of the radius; the shadow is
    /// the inverse (gone until `fade`, opaque at the rim). Shadow first,
    /// light on top.
    public struct Shade: Hashable, Sendable {
        public var light: String
        public var shadow: String
        public var center: Point
        public var radius: Double
        public static let fade: Double = 0.65
    }

    /// What to draw, in viewBox units.
    public struct Mark: Hashable, Sendable {
        public var shapeIndex: Int
        public var shape: String
        public var body: Body
        /// The body colour, `#rrggbb`.
        public var color: String
        /// The fitted pieces (centres and radii in viewBox units).
        public var pieces: [Piece]
        public var shade: Shade
        /// The eye and mouth colour.
        public var faceColor: String
        /// Left, then right.
        public var eyes: [Eye]
        public var mouth: Mouth
    }

    // MARK: - The frame

    /// The tangent-plane frame of a point on the face spheroid, projected
    /// orthographically, at rest (yaw = pitch = 0): core.js `_frame`.
    /// `surf` is already fitted. `z` is the point's depth (positive = facing).
    static func frame(surf su: Surf, lonDeg: Double, latDeg: Double) -> (m: Transform, z: Double) {
        let lon = lonDeg * .pi / 180
        let lat = latDeg * .pi / 180
        let p = (x: sin(lon) * cos(lat), y: sin(lat), z: cos(lon) * cos(lat))
        let e = (x: cos(lon), y: 0.0, z: -sin(lon))
        let n = (x: -sin(lon) * sin(lat), y: cos(lat), z: -cos(lon) * sin(lat))
        // The face sits on a spheroid: radii rx (x, z) and ry (y); the eye
        // disc keeps its size, so the frame is normalised by the mean radius.
        let avg = (su.rx + su.ry) / 2
        let kx = su.rx / avg
        let ky = su.ry / avg
        let m = Transform(
            a: e.x * kx, b: -e.y * ky,
            c: -n.x * kx, d: n.y * ky,
            tx: center + radius * (su.cx + su.rx * p.x),
            ty: center + radius * (su.cy - su.ry * p.y)
        )
        return (m, p.z)
    }

    // MARK: - The mark

    /// The character for `slug` wearing its chosen `avatar` (either field may
    /// be unset; see `BlobAvatar.resolve`), pulling `face`.
    public static func mark(slug: String, avatar: BotAvatar? = nil, face: Face = .calm) -> Mark {
        let look = BlobAvatar.resolve(slug: slug, avatar: avatar)
        return mark(shapeIndex: look.shapeIndex, colorHex: look.color, face: face)
    }

    /// One species (wrapping like the web's modulo) in a given colour.
    public static func mark(shapeIndex: Int, colorHex: String, face: Face = .calm) -> Mark {
        let shape = BotAvatar.shapeID(at: shapeIndex)
        let body = Body(rawValue: shape) ?? .bear
        return mark(body: body, colorHex: colorHex, face: face)
    }

    public static func mark(body: Body, colorHex: String, face: Face = .calm) -> Mark {
        let fit = body.fit
        let r = radius
        let su = body.surf.scaled(fit)
        let pieces = body.pieces.map { p in
            Piece(x: center + p.x * fit * r, y: center + p.y * fit * r, rx: p.rx * fit * r, ry: p.ry * fit * r, angle: p.angle)
        }

        let faceColor = OrbColor.lum(colorHex) > inkLuminance ? ink : white

        // Eyes: a fully rounded eyeW × eyeH box in the tangent frame, scaled
        // by eyeScale (and squash and the blink on the height), with a small
        // downward shift as the lid closes.
        let blink = min(1, max(0, face.blink))
        let open = 1 - blink * 0.94
        let sx = face.eyeScale
        let sy = face.eyeScale * face.squash * open
        let shift = blink * eyeH * 0.08
        let rx = min(eyeW, eyeH) / 2 * corner
        func eye(_ side: Double) -> Eye {
            let f = frame(surf: su, lonDeg: side * eyeLon, latDeg: eyeLat)
            return Eye(transform: f.m.translated(x: 0, y: shift), rx: rx * sx, ry: rx * sy)
        }
        let eyes = [eye(-1), eye(1)]

        // Mouth: a quadratic in the frame below the eyes.
        let fm = frame(surf: su, lonDeg: 0, latDeg: eyeLat - mouthDrop)
        let curve = face.mouth ?? mouthCurve
        let hw = 14 * face.eyeScale * face.mouthLen
        let mouth = Mouth(
            transform: fm.m,
            halfWidth: hw,
            bulge: curve * hw * 1.15,
            strokeWidth: mouthStroke * 1.3 * face.eyeScale
        )

        // Shade: the masks sit a little up and left of the point at lat 28°.
        let fs = frame(surf: su, lonDeg: 0, latDeg: 28)
        let shade = Shade(
            light: OrbColor.tintOf(colorHex, 1),
            shadow: OrbColor.tintOf(colorHex, -1),
            center: Point(fs.m.tx - 0.12 * r, fs.m.ty - 0.1 * r),
            radius: 1.35 * r
        )

        let index = BotAvatar.shapeIndex(named: body.rawValue) ?? 0
        return Mark(
            shapeIndex: index,
            shape: body.rawValue,
            body: body,
            color: colorHex,
            pieces: pieces,
            shade: shade,
            faceColor: faceColor,
            eyes: eyes,
            mouth: mouth
        )
    }
}

// MARK: - Colour

/// The colour maths from orb-mascot core.js (MIT): sRGB ↔ OKLab, so an equal
/// lightness step looks equal on every hue, and the light / shadow tints
/// whose contrast budget is split by the room the colour has in each
/// direction (dark bodies get most of it as light, light bodies as shadow).
public enum OrbColor {
    /// `#rgb` or `#rrggbb` (with or without the hash) to 0…255 components;
    /// anything unreadable is black.
    public static func hex2(_ hex: String) -> (r: Int, g: Int, b: Int) {
        var s = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("#") { s.removeFirst() }
        if s.count == 3 {
            s = s.map { String($0) + String($0) }.joined()
        }
        var v: UInt64 = 0
        Scanner(string: s).scanHexInt64(&v)
        return (Int((v >> 16) & 255), Int((v >> 8) & 255), Int(v & 255))
    }

    /// Relative luminance of the sRGB bytes (not linearised), 0…1.
    public static func lum(_ hex: String) -> Double {
        let c = hex2(hex)
        return (0.2126 * Double(c.r) + 0.7152 * Double(c.g) + 0.0722 * Double(c.b)) / 255
    }

    static func s2l(_ byte: Int) -> Double {
        let v = Double(byte) / 255
        return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4)
    }

    /// Linear 0…1 to sRGB 0…1 (clamped); `BotAvatar.hex` rounds it to a byte.
    static func l2s(_ lin: Double) -> Double {
        let v = max(0, min(1, lin))
        return v <= 0.0031308 ? 12.92 * v : 1.055 * pow(v, 1 / 2.4) - 0.055
    }

    static func rgb2ok(_ c: (r: Int, g: Int, b: Int)) -> (L: Double, a: Double, b: Double) {
        let r = s2l(c.r), g = s2l(c.g), b = s2l(c.b)
        let l = cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
        let m = cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
        let q = cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
        return (
            0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * q,
            1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * q,
            0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * q
        )
    }

    static func ok2rgb(_ L: Double, _ a: Double, _ b: Double) -> [Double] {
        let l = pow(L + 0.3963377774 * a + 0.2158037573 * b, 3)
        let m = pow(L - 0.1055613458 * a - 0.0638541728 * b, 3)
        let q = pow(L - 0.0894841775 * a - 1.2914855480 * b, 3)
        return [
            4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * q,
            -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * q,
            -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * q,
        ]
    }

    static func inGamut(_ c: [Double]) -> Bool {
        c.allSatisfy { $0 > -0.002 && $0 < 1.002 }
    }

    /// The OKLab lightness of a colour, 0…1.
    public static func lightness(_ hex: String) -> Double {
        rgb2ok(hex2(hex)).L
    }

    /// `hex` with its OKLab lightness moved by `dl`. When the result falls
    /// out of gamut the chroma is pulled in (keeping the lightness) until it
    /// fits.
    public static func shiftL(_ hex: String, _ dl: Double) -> String {
        let ok = rgb2ok(hex2(hex))
        let L = max(0, min(1, ok.L + dl))
        var a = ok.a
        var b = ok.b
        var c = ok2rgb(L, a, b)
        var i = 0
        while i < 14 && !inGamut(c) {
            a *= 0.85
            b *= 0.85
            c = ok2rgb(L, a, b)
            i += 1
        }
        return BotAvatar.hex(red: l2s(c[0]), green: l2s(c[1]), blue: l2s(c[2]))
    }

    /// The light (`dir > 0`) or shadow (`dir < 0`) tint of a body colour.
    public static func tintOf(_ hex: String, _ dir: Double) -> String {
        let L = rgb2ok(hex2(hex)).L
        let dl = dir > 0 ? min(0.03 + 0.15 * (1 - L), 0.8 * (1 - L)) : -min(0.04 + 0.05 * L, 0.8 * L)
        return shiftL(hex, dl)
    }
}
