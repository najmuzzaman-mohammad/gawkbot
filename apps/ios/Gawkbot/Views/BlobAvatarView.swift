import SwiftUI
import GawkbotKit

/// The bot's mark, drawn as a smooth vector (`SmoothBlob`, the port of
/// blobAvatarSmooth.ts): one flat filled body with the eyes cut out. The
/// silhouette and colour are the bot's chosen `avatar` where one is set,
/// otherwise the same slug-derived look as the office web app
/// (`BlobAvatar.resolve`). The path is filled even-odd, so the eyes are
/// holes and the mark composites on any surface. `openness` narrows the eyes.
struct BlobAvatarView: View {
    let slug: String
    var avatar: BotAvatar? = nil
    var size: CGFloat = 40
    var openness: Double = 1

    var body: some View {
        let look = BlobAvatar.resolve(slug: slug, avatar: avatar)
        BlobShape(slug: slug, avatar: avatar, openness: openness)
            .fill(Color(hex: look.color), style: FillStyle(eoFill: true, antialiased: true))
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// The smooth blob as a SwiftUI shape: body spline plus two rounded-rect
/// eyes in one path. Scaled from the 16-unit grid to fit, centred.
struct BlobShape: Shape {
    let slug: String
    var avatar: BotAvatar? = nil
    var openness: Double

    var animatableData: Double {
        get { openness }
        set { openness = newValue }
    }

    func path(in rect: CGRect) -> Path {
        let mark = SmoothBlob.mark(slug, avatar: avatar, openness: openness)
        let grid = CGFloat(BlobAvatar.grid)
        let scale = min(rect.width, rect.height) / grid
        let originX = rect.midX - scale * grid / 2
        let originY = rect.midY - scale * grid / 2
        func point(_ p: SmoothBlob.Point) -> CGPoint {
            CGPoint(x: originX + CGFloat(p.x) * scale, y: originY + CGFloat(p.y) * scale)
        }

        var path = Path()
        guard !mark.segments.isEmpty else { return path }
        path.move(to: point(mark.start))
        for segment in mark.segments {
            path.addCurve(to: point(segment.end), control1: point(segment.control1), control2: point(segment.control2))
        }
        path.closeSubpath()
        for eye in mark.eyes {
            let box = CGRect(
                x: originX + CGFloat(eye.x) * scale,
                y: originY + CGFloat(eye.y) * scale,
                width: CGFloat(eye.width) * scale,
                height: CGFloat(eye.height) * scale
            )
            let r = CGFloat(eye.cornerRadius) * scale
            path.addRoundedRect(in: box, cornerSize: CGSize(width: r, height: r), style: .circular)
        }
        return path
    }
}

/// A squishy avatar. With a mood it plays that mood's loop (hop, bob and
/// blink, breathe, shake, happy hop); large ones also blink now and then;
/// a tap squashes it and springs it back with a light haptic. All the maths
/// is `MoodMotion` in GawkbotKit. Driven by a TimelineView that pauses when
/// nothing is moving; Reduce Motion keeps it still (a tap still gives the
/// haptic).
struct MoodAvatarView: View {
    let slug: String
    var avatar: BotAvatar? = nil
    /// Nil: no loop. It still squishes on tap, and blinks when large.
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

    private var blinks: Bool { size >= MoodAvatarView.blinkSize }
    private var paused: Bool { reduceMotion || (mood == nil && !blinks && !squishing) }

    var body: some View {
        let look = BlobAvatar.resolve(slug: slug, avatar: avatar)
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: paused)) { context in
            let p = currentPose(at: context.date)
            BlobAvatarView(slug: slug, avatar: avatar, size: size, openness: p.openness)
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
/// bobbing and blinking while it is mid-turn.
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
