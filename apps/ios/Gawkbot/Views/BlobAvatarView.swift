import SwiftUI
import GawkbotKit

/// The bot's character, painted from `OrbAvatar` (ported from orb-mascot
/// core.js, MIT): a goo body of circles, a light and a shadow tint, and two
/// eyes and a mouth on the sphere inside. The body and colour are the bot's
/// chosen `avatar` where one is set, otherwise the slug-derived look
/// (`BlobAvatar.resolve`). `face` is the still pose; `openness` closes the
/// eyes (a blink: `blink = 1 - openness`).
struct BlobAvatarView: View {
    let slug: String
    var avatar: BotAvatar? = nil
    var size: CGFloat = 40
    var openness: Double = 1
    var face: OrbAvatar.Face = .calm

    /// The face with the motion's blink folded in (whichever is more shut).
    private var pose: OrbAvatar.Face {
        var f = face
        f.blink = max(f.blink, 1 - min(1, max(0, openness)))
        return f
    }

    var body: some View {
        OrbCanvas(mark: OrbAvatar.mark(slug: slug, avatar: avatar, face: pose))
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// Paints an `OrbAvatar.Mark` into a square in the mascot's drawing order:
/// the goo body, then, clipped to that same goo, the shadow tint, the light
/// tint, the eyes and the mouth.
struct OrbCanvas: View {
    let mark: OrbAvatar.Mark

    var body: some View {
        Canvas(rendersAsynchronously: false) { context, size in
            let scale = min(size.width, size.height) / CGFloat(OrbAvatar.view)
            // The viewBox starts at (-24, -24): the origin is where (0, 0) lands.
            let origin = CGPoint(
                x: (size.width - scale * CGFloat(OrbAvatar.view)) / 2 - CGFloat(OrbAvatar.viewOrigin) * scale,
                y: (size.height - scale * CGFloat(OrbAvatar.view)) / 2 - CGFloat(OrbAvatar.viewOrigin) * scale
            )
            let painter = OrbPainter(scale: scale, origin: origin, mark: mark)
            painter.paint(in: &context, size: size)
        }
    }
}

/// Mark → Canvas drawing, scaled from the 248-unit viewBox.
struct OrbPainter {
    let scale: CGFloat
    let origin: CGPoint
    let mark: OrbAvatar.Mark

    /// ViewBox units → canvas points.
    var canvasTransform: CGAffineTransform {
        CGAffineTransform(a: scale, b: 0, c: 0, d: scale, tx: origin.x, ty: origin.y)
    }

    func point(_ p: OrbAvatar.Point) -> CGPoint {
        CGPoint(x: origin.x + CGFloat(p.x) * scale, y: origin.y + CGFloat(p.y) * scale)
    }

    /// A mark transform (viewBox units in and out) followed by the canvas scale.
    func transform(_ t: OrbAvatar.Transform) -> CGAffineTransform {
        CGAffineTransform(a: CGFloat(t.a), b: CGFloat(t.b), c: CGFloat(t.c), d: CGFloat(t.d), tx: CGFloat(t.tx), ty: CGFloat(t.ty))
            .concatenating(canvasTransform)
    }

    /// One body piece: a circle, or an ellipse rotated about its centre.
    func path(_ p: OrbAvatar.Piece) -> Path {
        let c = point(OrbAvatar.Point(p.x, p.y))
        let rect = CGRect(
            x: c.x - CGFloat(p.rx) * scale, y: c.y - CGFloat(p.ry) * scale,
            width: CGFloat(p.rx) * 2 * scale, height: CGFloat(p.ry) * 2 * scale
        )
        var ellipse = Path(ellipseIn: rect)
        if p.angle != 0 {
            let t = CGAffineTransform(translationX: c.x, y: c.y)
                .rotated(by: CGFloat(p.angle) * .pi / 180)
                .translatedBy(x: -c.x, y: -c.y)
            ellipse = ellipse.applying(t)
        }
        return ellipse
    }

    /// The goo: the pieces drawn into one layer that is blurred and then
    /// alpha-thresholded, so the union reads as one filleted blob in `color`
    /// (core.js: feGaussianBlur stdDeviation 7.5, then alpha' = 24·alpha − 11).
    /// This is Apple's metaball recipe for Canvas: add the threshold, then
    /// the blur, then draw the shapes in a layer; the blur runs on the
    /// drawing and the threshold on its result.
    func goo(in context: inout GraphicsContext, color: Color) {
        context.addFilter(.alphaThreshold(min: OrbAvatar.alphaThreshold, color: color))
        context.addFilter(.blur(radius: CGFloat(OrbAvatar.blurStdDeviation) * scale))
        context.drawLayer { layer in
            for p in mark.pieces {
                layer.fill(path(p), with: .color(color))
            }
        }
    }

    func paint(in context: inout GraphicsContext, size: CGSize) {
        let bodyColor = Color(hex: mark.color)
        let faceColor = Color(hex: mark.faceColor)

        // 1. The body.
        var body = context
        goo(in: &body, color: bodyColor)

        // 2. Everything else is clipped to the same goo (the mascot's face mask).
        var face = context
        face.clipToLayer { layer in
            goo(in: &layer, color: .black)
        }

        // 3. Shade: shadow first, light on top, each the tint faded by a radial
        //    alpha mask about the same centre.
        let canvas = Path(CGRect(origin: .zero, size: size))
        let center = point(mark.shade.center)
        let radius = CGFloat(mark.shade.radius) * scale
        let fade = OrbAvatar.Shade.fade
        let shadow = Color(hex: mark.shade.shadow)
        let light = Color(hex: mark.shade.light)
        face.fill(canvas, with: .radialGradient(
            Gradient(stops: [
                .init(color: shadow.opacity(0), location: 0),
                .init(color: shadow.opacity(0), location: fade),
                .init(color: shadow, location: 1),
            ]),
            center: center, startRadius: 0, endRadius: radius
        ))
        face.fill(canvas, with: .radialGradient(
            Gradient(stops: [
                .init(color: light, location: 0),
                .init(color: light.opacity(0), location: fade),
                .init(color: light.opacity(0), location: 1),
            ]),
            center: center, startRadius: 0, endRadius: radius
        ))

        // 4. Eyes: a disc in the eye's own plane, mapped by its frame.
        for eye in mark.eyes {
            let disc = Path(ellipseIn: CGRect(
                x: -CGFloat(eye.rx), y: -CGFloat(eye.ry),
                width: CGFloat(eye.rx) * 2, height: CGFloat(eye.ry) * 2
            ))
            face.fill(disc.applying(transform(eye.transform)), with: .color(faceColor))
        }

        // 5. Mouth: stroked in its own plane, with the frame on the context,
        //    so the frame's scale shapes the stroke too (as SVG does).
        var mouth = face
        mouth.transform = transform(mark.mouth.transform).concatenating(face.transform)
        let hw = CGFloat(mark.mouth.halfWidth)
        var curve = Path()
        curve.move(to: CGPoint(x: -hw, y: 0))
        curve.addQuadCurve(to: CGPoint(x: hw, y: 0), control: CGPoint(x: 0, y: CGFloat(mark.mouth.bulge)))
        mouth.stroke(
            curve,
            with: .color(faceColor),
            style: StrokeStyle(lineWidth: CGFloat(mark.mouth.strokeWidth), lineCap: .round, lineJoin: .round)
        )
    }
}

extension Mood {
    /// The still face a bot pulls in each mood.
    var face: OrbAvatar.Face {
        switch self {
        case .working: return .working
        case .idle: return .sleepy
        case .needsYou: return .asking
        case .error: return .oops
        case .done: return .happy
        }
    }
}

/// A squishy avatar. With a mood it pulls that mood's face and plays its
/// loop (hop, bob and blink, breathe, shake, happy hop); large ones also
/// blink now and then; a tap squashes it and springs it back with a light
/// haptic. All the maths is `MoodMotion` in GawkbotKit. Driven by a
/// TimelineView that pauses when nothing is moving; Reduce Motion keeps it
/// still (a tap still gives the haptic).
struct MoodAvatarView: View {
    let slug: String
    var avatar: BotAvatar? = nil
    /// Nil: a calm face and no loop. It still squishes on tap, and blinks when large.
    var mood: Mood? = nil
    var size: CGFloat = 44
    /// A soft disc of the avatar's own colour behind it.
    var halo: Bool = false
    /// Off where a tap belongs to something else (a List row's link).
    var squishOnTap: Bool = true

    /// From this size up an avatar is big enough for a blink to read.
    static let blinkSize: CGFloat = 56

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var tappedAt: Date?
    @State private var squishing = false

    private var blinks: Bool { size >= MoodAvatarView.blinkSize && mood != .done }
    private var paused: Bool { reduceMotion || (mood == nil && !blinks && !squishing) }

    var body: some View {
        let look = BlobAvatar.resolve(slug: slug, avatar: avatar)
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: paused)) { context in
            let p = currentPose(at: context.date)
            BlobAvatarView(slug: slug, avatar: avatar, size: size, openness: p.openness, face: mood?.face ?? .calm)
                .scaleEffect(x: CGFloat(p.scaleX), y: CGFloat(p.scaleY), anchor: .bottom)
                .rotationEffect(.degrees(p.rotation), anchor: .bottom)
                .offset(x: CGFloat(p.dx) * size, y: CGFloat(p.dy) * size)
        }
        .frame(width: size, height: size)
        .padding(halo ? size * 0.14 : 0)
        .background {
            if halo {
                Circle().fill(Color(hex: look.color).opacity(0.16))
            }
        }
        .contentShape(Circle())
        .simultaneousGesture(TapGesture().onEnded { squish() }, including: squishOnTap ? .all : .subviews)
        .accessibilityHidden(true)
    }

    private func currentPose(at date: Date) -> MoodPose {
        guard !reduceMotion else { return .rest }
        let t = date.timeIntervalSinceReferenceDate
        let seed = MoodMotion.seed(for: slug)
        var p = MoodMotion.pose(for: mood, time: t, seed: seed)
        if blinks {
            p.openness = min(p.openness, MoodMotion.idleBlink(time: t, seed: seed))
        }
        if let tappedAt {
            p = p.combined(with: MoodMotion.tap(elapsed: date.timeIntervalSince(tappedAt)))
        }
        return p
    }

    private func squish() {
        Haptics.lightTap()
        guard !reduceMotion else { return }
        let now = Date()
        tappedAt = now
        squishing = true
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(MoodMotion.tapDuration))
            // A newer tap restarts the spring; only the last one stops the clock.
            if tappedAt == now {
                squishing = false
                tappedAt = nil
            }
        }
    }
}

/// A conversation-list or toolbar avatar: still while the bot is idle,
/// concentrating (bobbing and gawking) while it is mid-turn.
struct WorkingBlobAvatarView: View {
    let slug: String
    var avatar: BotAvatar? = nil
    var size: CGFloat = 40
    let working: Bool
    var halo: Bool = false
    var squishOnTap: Bool = false

    var body: some View {
        MoodAvatarView(slug: slug, avatar: avatar, mood: working ? .working : nil, size: size, halo: halo, squishOnTap: squishOnTap)
    }
}

extension Color {
    init(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("#") { s.removeFirst() }
        var v: UInt64 = 0
        Scanner(string: s).scanHexInt64(&v)
        let r = Double((v >> 16) & 0xff) / 255
        let g = Double((v >> 8) & 0xff) / 255
        let b = Double(v & 0xff) / 255
        self.init(red: r, green: g, blue: b)
    }
}
