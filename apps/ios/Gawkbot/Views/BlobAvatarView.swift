import SwiftUI
import GawkbotKit

/// The bot's mark, same silhouette and colour as the office web app, drawn
/// as a smooth vector (`SmoothBlob`, the port of blobAvatarSmooth.ts). The
/// eyes are holes: the path is filled even-odd, so the background shows
/// through and it composites on any surface. `openness` narrows the eyes;
/// the working bot blinks.
struct BlobAvatarView: View {
    let slug: String
    var size: CGFloat = 40
    var openness: Double = 1

    var body: some View {
        BlobShape(slug: slug, openness: openness)
            .fill(Color(hex: BlobAvatar.colorHex(slug)), style: FillStyle(eoFill: true, antialiased: true))
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// The smooth blob as a SwiftUI shape: body spline plus two rounded-rect
/// eyes in one path. Scaled from the 16-unit grid to fit, centred.
struct BlobShape: Shape {
    let slug: String
    var openness: Double

    var animatableData: Double {
        get { openness }
        set { openness = newValue }
    }

    func path(in rect: CGRect) -> Path {
        let mark = SmoothBlob.mark(slug, openness: openness)
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

/// An avatar with its mood's small loop: bounce (needs you), bob and blink
/// (working), breathe (idle), shake (error), hop (done). Driven by a
/// TimelineView so it costs nothing when paused; Reduce Motion keeps it
/// still.
struct MoodAvatarView: View {
    let slug: String
    let mood: Mood
    var size: CGFloat = 44
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: reduceMotion)) { context in
            let pose = MoodMotion.pose(
                for: reduceMotion ? nil : mood,
                time: context.date.timeIntervalSinceReferenceDate,
                seed: MoodMotion.seed(for: slug)
            )
            BlobAvatarView(slug: slug, size: size, openness: pose.openness)
                .scaleEffect(x: CGFloat(pose.scaleX), y: CGFloat(pose.scaleY), anchor: .bottom)
                .rotationEffect(.degrees(pose.rotation), anchor: .bottom)
                .offset(x: CGFloat(pose.dx) * size, y: CGFloat(pose.dy) * size)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// A bot that is mid-turn blinks like the sidebar avatar in the office.
struct WorkingBlobAvatarView: View {
    let slug: String
    var size: CGFloat = 40
    let working: Bool
    @State private var openness: Double = 1

    var body: some View {
        BlobAvatarView(slug: slug, size: size, openness: working ? openness : 1)
            .task(id: working) {
                guard working else { openness = 1; return }
                while !Task.isCancelled {
                    try? await Task.sleep(for: .milliseconds(Int.random(in: 1800...3200)))
                    withAnimation(.easeInOut(duration: 0.12)) { openness = 0 }
                    try? await Task.sleep(for: .milliseconds(140))
                    withAnimation(.easeInOut(duration: 0.12)) { openness = 1 }
                }
            }
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
