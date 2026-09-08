import SwiftUI
import GawkbotKit

/// The bot's mark, same silhouette and colour as the office web app. The
/// eyes are holes: the background shows through, so it composites on any
/// surface. `openness` narrows the eyes; the working bot blinks.
struct BlobAvatarView: View {
    let slug: String
    var size: CGFloat = 40
    var openness: Double = 1

    var body: some View {
        Canvas { ctx, sz in
            let cell = min(sz.width, sz.height) / CGFloat(BlobAvatar.grid)
            let color = Color(hex: BlobAvatar.colorHex(slug))
            for c in BlobAvatar.cells(slug, openness: openness) {
                let rect = CGRect(x: CGFloat(c.x) * cell, y: CGFloat(c.y) * cell, width: cell + 0.5, height: cell + 0.5)
                ctx.fill(Path(rect), with: .color(color))
            }
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
