import SwiftUI
import GawkbotKit

struct MessageRow: View {
    let message: ChatMessage
    let botSlug: String
    let isTail: Bool

    var body: some View {
        if message.isSystem || message.kind == "system" || message.kind == "task_created" || message.kind == "task_updated" {
            SystemLine(text: message.content)
        } else if message.isFromHuman {
            HStack(alignment: .bottom) {
                Spacer(minLength: 60)
                Bubble(text: message.content, mine: true, tail: isTail)
            }
            .padding(.bottom, isTail ? 6 : 0)
        } else {
            HStack(alignment: .bottom, spacing: 6) {
                if isTail {
                    BlobAvatarView(slug: message.from, size: 26)
                } else {
                    Color.clear.frame(width: 26, height: 26)
                }
                Bubble(text: message.content, mine: false, tail: isTail)
                Spacer(minLength: 60)
            }
            .padding(.bottom, isTail ? 6 : 0)
        }
    }
}

/// An iMessage-shaped bubble. Blue for the human, gray for the bot, with a
/// tail on the last bubble of a run.
struct Bubble: View {
    let text: String
    let mine: Bool
    let tail: Bool

    var body: some View {
        Text(LocalizedStringKey(text))
            .font(.body)
            .foregroundStyle(mine ? Color.white : Color.primary)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(BubbleShape(mine: mine, tail: tail).fill(mine ? Color.accentColor : Color(.systemGray5)))
            .textSelection(.enabled)
            .accessibilityLabel(mine ? "You said: \(text)" : text)
    }
}

/// Rounded rectangle with a small tail at the bottom corner nearest the sender.
struct BubbleShape: Shape {
    let mine: Bool
    let tail: Bool
    private let radius: CGFloat = 18

    func path(in rect: CGRect) -> Path {
        var p = Path(roundedRect: rect, cornerRadius: radius, style: .continuous)
        guard tail else { return p }
        let w = rect.width, h = rect.height
        var t = Path()
        if mine {
            t.move(to: CGPoint(x: w - radius, y: h))
            t.addQuadCurve(to: CGPoint(x: w + 6, y: h), control: CGPoint(x: w - 2, y: h - 1))
            t.addQuadCurve(to: CGPoint(x: w - 4, y: h - 12), control: CGPoint(x: w - 1, y: h - 4))
        } else {
            t.move(to: CGPoint(x: radius, y: h))
            t.addQuadCurve(to: CGPoint(x: -6, y: h), control: CGPoint(x: 2, y: h - 1))
            t.addQuadCurve(to: CGPoint(x: 4, y: h - 12), control: CGPoint(x: 1, y: h - 4))
        }
        t.closeSubpath()
        p.addPath(t)
        return p
    }
}

struct SystemLine: View {
    let text: String
    var body: some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
    }
}
