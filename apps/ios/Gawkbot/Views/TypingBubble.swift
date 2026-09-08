import SwiftUI

/// The three bouncing dots iMessage shows while the other side types.
struct TypingBubble: View {
    let slug: String
    @State private var phase = 0

    var body: some View {
        HStack(alignment: .bottom, spacing: 6) {
            BlobAvatarView(slug: slug, size: 26)
            HStack(spacing: 5) {
                ForEach(0..<3, id: \.self) { i in
                    Circle()
                        .fill(Color(.systemGray))
                        .frame(width: 8, height: 8)
                        .offset(y: phase == i ? -3 : 0)
                        .opacity(phase == i ? 1 : 0.55)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(BubbleShape(mine: false, tail: true).fill(Color(.systemGray5)))
            Spacer(minLength: 60)
        }
        .accessibilityLabel("Typing")
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(320))
                withAnimation(.easeInOut(duration: 0.25)) { phase = (phase + 1) % 3 }
            }
        }
    }
}
