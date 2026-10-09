import SwiftUI
import GawkbotKit

/// The bot's character, painted from `GawkAvatar` (the port of
/// web/src/lib/gawkAvatar.ts): a lit, glossy body with a face and the
/// species' accessory. The species and colour are the bot's chosen `avatar`
/// where one is set, otherwise the slug-derived look (`BlobAvatar.resolve`).
/// `expression` is the face; `openness` narrows the eyes (a blink).
struct BlobAvatarView: View {
    let slug: String
    var avatar: BotAvatar? = nil
    var size: CGFloat = 40
    var openness: Double = 1
    var expression: GawkAvatar.Expression = .calm

    var body: some View {
        let mark = GawkAvatar.mark(slug, avatar: avatar, expression: expression, openness: openness)
        GawkCanvas(mark: mark)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// Paints a `GawkAvatar.Mark` into a square, in the web's drawing order:
/// shadow and the accessory parts behind, the body with its gradient, the
/// shading clipped to the body, the eyes, then the accessory parts in front
/// and the face.
struct GawkCanvas: View {
    let mark: GawkAvatar.Mark

    var body: some View {
        Canvas(rendersAsynchronously: false) { context, size in
            let scale = min(size.width, size.height) / GawkAvatar.view
            let origin = CGPoint(
                x: (size.width - scale * GawkAvatar.view) / 2,
                y: (size.height - scale * GawkAvatar.view) / 2
            )
            let painter = GawkPainter(scale: scale, origin: origin, mark: mark)
            let bodyPath = painter.path(.curve(mark.body, closed: true))
            for p in mark.behind { painter.draw(p, in: context, bodyPath: bodyPath) }
            context.fill(bodyPath, with: painter.shading(.body, bounds: bodyPath.boundingRect))
            for p in mark.shading { painter.draw(p, in: context, bodyPath: bodyPath) }
            for p in mark.eyes { painter.draw(p, in: context, bodyPath: bodyPath) }
            for p in mark.front { painter.draw(p, in: context, bodyPath: bodyPath) }
        }
    }
}

/// Geometry → Path and Fill → Shading, scaled from the 64-unit box.
struct GawkPainter {
    let scale: CGFloat
    let origin: CGPoint
    let mark: GawkAvatar.Mark

    func point(_ p: GawkAvatar.Point) -> CGPoint {
        CGPoint(x: origin.x + CGFloat(p.x) * scale, y: origin.y + CGFloat(p.y) * scale)
    }

    func path(_ g: GawkAvatar.Geometry) -> Path {
        var path = Path()
        switch g {
        case let .curve(curve, closed):
            path.move(to: point(curve.start))
            for s in curve.segments {
                path.addCurve(to: point(s.end), control1: point(s.control1), control2: point(s.control2))
            }
            if closed { path.closeSubpath() }
        case let .line(a, b):
            path.move(to: point(a))
            path.addLine(to: point(b))
        case let .quads(start, legs):
            path.move(to: point(start))
            for leg in legs {
                path.addQuadCurve(to: point(leg.end), control: point(leg.control))
            }
        case let .ellipse(center, rx, ry, rotation):
            let c = point(center)
            let rect = CGRect(x: c.x - CGFloat(rx) * scale, y: c.y - CGFloat(ry) * scale, width: CGFloat(rx) * 2 * scale, height: CGFloat(ry) * 2 * scale)
            var ellipse = Path(ellipseIn: rect)
            if rotation != 0 {
                let t = CGAffineTransform(translationX: c.x, y: c.y)
                    .rotated(by: CGFloat(rotation) * .pi / 180)
                    .translatedBy(x: -c.x, y: -c.y)
                ellipse = ellipse.applying(t)
            }
            path.addPath(ellipse)
        case let .circle(center, r):
            let c = point(center)
            path.addEllipse(in: CGRect(x: c.x - CGFloat(r) * scale, y: c.y - CGFloat(r) * scale, width: CGFloat(r) * 2 * scale, height: CGFloat(r) * 2 * scale))
        }
        return path
    }

    /// The shading for a fill, with gradients laid out over `bounds` the way
    /// SVG lays them over an element's bounding box.
    func shading(_ fill: GawkAvatar.Fill, bounds: CGRect) -> GraphicsContext.Shading {
        let t = mark.tones
        func at(_ fx: Double, _ fy: Double) -> CGPoint {
            CGPoint(x: bounds.minX + bounds.width * CGFloat(fx), y: bounds.minY + bounds.height * CGFloat(fy))
        }
        let radius = max(bounds.width, bounds.height)
        switch fill {
        case let .color(hex):
            return .color(Color(hex: hex))
        case .body:
            return .linearGradient(
                Gradient(stops: [
                    .init(color: Color(hex: t.light), location: 0),
                    .init(color: Color(hex: t.base), location: 0.5),
                    .init(color: Color(hex: t.dark), location: 1),
                ]),
                startPoint: at(0.2, 0), endPoint: at(0.8, 1)
            )
        case .sheen:
            return .radialGradient(
                Gradient(stops: [.init(color: .white.opacity(0.5), location: 0), .init(color: .white.opacity(0), location: 1)]),
                center: at(0.32, 0.22), startRadius: 0, endRadius: radius * 0.55
            )
        case .bounce:
            let light = Color(hex: t.light)
            return .radialGradient(
                Gradient(stops: [.init(color: light.opacity(0.45), location: 0), .init(color: light.opacity(0), location: 1)]),
                center: at(0.5, 1.05), startRadius: 0, endRadius: radius * 0.6
            )
        case .shadow:
            return .radialGradient(
                Gradient(stops: [.init(color: .black.opacity(0.28), location: 0), .init(color: .black.opacity(0), location: 1)]),
                center: at(0.5, 0.5), startRadius: 0, endRadius: bounds.width * 0.5
            )
        case .ball:
            return .radialGradient(
                Gradient(stops: [.init(color: Color(hex: t.light), location: 0), .init(color: Color(hex: t.dark), location: 1)]),
                center: at(0.35, 0.3), startRadius: 0, endRadius: radius * 0.75
            )
        }
    }

    func draw(_ p: GawkAvatar.Primitive, in context: GraphicsContext, bodyPath: Path) {
        var ctx = context
        if p.paint.clipToBody { ctx.clip(to: bodyPath) }
        ctx.opacity = p.paint.opacity
        let shape = path(p.geometry)
        if let fill = p.paint.fill {
            ctx.fill(shape, with: shading(fill, bounds: shape.boundingRect))
        }
        if let stroke = p.paint.stroke {
            ctx.stroke(
                shape,
                with: .color(Color(hex: stroke)),
                style: StrokeStyle(lineWidth: CGFloat(p.paint.strokeWidth) * scale, lineCap: .round, lineJoin: .round)
            )
        }
    }
}

extension Mood {
    /// The face a bot pulls in each mood.
    var expression: GawkAvatar.Expression {
        switch self {
        case .working: return .focus
        case .idle: return .sleepy
        case .needsYou: return .ask
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
            BlobAvatarView(slug: slug, avatar: avatar, size: size, openness: p.openness, expression: mood?.expression ?? .calm)
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
