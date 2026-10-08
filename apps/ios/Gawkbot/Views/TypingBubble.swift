import SwiftUI
import GawkbotKit

/// The three bouncing dots iMessage shows while the other side types, in
/// the bot's soft bubble with its avatar beside it.
struct TypingBubble: View {
    let slug: String
    var avatar: BotAvatar? = nil
    @State private var phase = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            BlobAvatarView(slug: slug, avatar: avatar, size: MessageRow.avatarSize)
                .padding(.top, 3)
            HStack(spacing: 5) {
                ForEach(0..<3, id: \.self) { i in
                    Circle()
                        .fill(Color.secondary)
                        .frame(width: 8, height: 8)
                        .offset(y: phase == i && !reduceMotion ? -3 : 0)
                        .opacity(phase == i ? 1 : 0.45)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 13)
            .background(BubbleShape(mine: false, tail: true).fill(Color.softBubble))
            Spacer(minLength: 56)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Typing")
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(320))
                withAnimation(.easeInOut(duration: 0.25)) { phase = (phase + 1) % 3 }
            }
        }
    }
}
