import SwiftUI
import GawkbotKit

extension ChatMessage {
    /// Office notices, acks and task changes: a centred grey line, not a bubble.
    var rendersAsSystemLine: Bool {
        isSystem || kind == "system" || kind == "task_created" || kind == "task_updated"
    }
}

/// One message, iMessage style: yours on the right in the accent, the bot's
/// on the left in a soft neutral bubble with its avatar beside the first
/// bubble of each run, office notices centred.
struct MessageRow: View {
    let message: ChatMessage
    /// The sender's chosen look (nil: derived from the slug).
    var avatar: BotAvatar? = nil
    /// First bubble of a run from this sender: carries the avatar and a gap above.
    let isRunStart: Bool
    /// Last bubble of a run: carries the tail and a gap below.
    let isTail: Bool

    static let avatarSize: CGFloat = 28

    var body: some View {
        if message.rendersAsSystemLine {
            SystemLine(text: message.content)
        } else if message.isFromHuman {
            HStack(alignment: .bottom) {
                Spacer(minLength: 56)
                Bubble(text: message.content, mine: true, tail: isTail)
            }
            .padding(.top, isRunStart ? 6 : 0)
            .padding(.bottom, isTail ? 4 : 0)
        } else {
            HStack(alignment: .top, spacing: 8) {
                if isRunStart {
                    BlobAvatarView(slug: message.from, avatar: avatar, size: MessageRow.avatarSize)
                        .padding(.top, 3)
                } else {
                    Color.clear.frame(width: MessageRow.avatarSize, height: 1)
                }
                Bubble(text: message.content, mine: false, tail: isTail)
                Spacer(minLength: 56)
            }
            .padding(.top, isRunStart ? 6 : 0)
            .padding(.bottom, isTail ? 4 : 0)
        }
    }
}

/// An iMessage-shaped bubble: the accent with white text for the human, a
/// soft neutral for the bot, with a tail on the last bubble of a run.
struct Bubble: View {
    let text: String
    let mine: Bool
    let tail: Bool

    var body: some View {
        // Verbatim on purpose: bot output is untrusted, and the markdown
        // initializer would turn "[click](https://…)" into a tappable link.
        Text(verbatim: text)
            .font(.body)
            .foregroundStyle(mine ? Color(uiColor: .systemBackground) : Color.primary)
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(BubbleShape(mine: mine, tail: tail).fill(mine ? Color.accentColor : Color.softBubble))
            .textSelection(.enabled)
            .accessibilityLabel(mine ? "You said: \(text)" : text)
    }
}

/// Rounded rectangle with a small tail at the bottom corner nearest the sender.
struct BubbleShape: Shape {
    let mine: Bool
    let tail: Bool
    private let radius: CGFloat = 20

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
        Text(verbatim: text)
            .font(.caption)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
    }
}
