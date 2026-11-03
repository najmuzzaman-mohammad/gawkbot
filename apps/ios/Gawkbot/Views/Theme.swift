import SwiftUI
import UIKit
import GawkbotKit

// The app's "soft" look: flat, friendly, a little squishy. Soft neutral
// canvases, solid rounded cards with a hairline and a gentle shadow, and
// neutral fills for buttons and bot bubbles. Every colour is a light/dark
// pair, so it follows the system appearance on its own. System materials
// are kept for the few things that float over content (the voice bar, the
// composer, sheets).

extension Color {
    private static func pair(light: UIColor, dark: UIColor) -> Color {
        Color(uiColor: UIColor { traits in traits.userInterfaceStyle == .dark ? dark : light })
    }

    /// Page background: warm off-white in light, soft charcoal in dark.
    static let softCanvas = pair(
        light: UIColor(red: 0.961, green: 0.957, blue: 0.945, alpha: 1),
        dark: UIColor(red: 0.075, green: 0.075, blue: 0.082, alpha: 1)
    )

    /// Cards sitting on the canvas.
    static let softCard = pair(
        light: UIColor(red: 1, green: 1, blue: 1, alpha: 1),
        dark: UIColor(red: 0.137, green: 0.137, blue: 0.149, alpha: 1)
    )

    /// A bot's chat bubble: a soft neutral, a step off the canvas.
    static let softBubble = pair(
        light: UIColor(red: 0.906, green: 0.902, blue: 0.890, alpha: 1),
        dark: UIColor(red: 0.188, green: 0.188, blue: 0.204, alpha: 1)
    )

    /// Quiet fills for buttons, fields and chips, on a card or the canvas.
    static let softFill = pair(
        light: UIColor(white: 0, alpha: 0.05),
        dark: UIColor(white: 1, alpha: 0.08)
    )

    /// The hairline round a card.
    static let softHairline = pair(
        light: UIColor(white: 0, alpha: 0.06),
        dark: UIColor(white: 1, alpha: 0.07)
    )
}

/// The soft canvas behind a screen, with one faint, static wash of the
/// accent at the top so it is not flat grey. No motion.
struct SoftBackdrop: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ZStack(alignment: .top) {
            Color.softCanvas
            LinearGradient(
                colors: [Color.accentColor.opacity(scheme == .dark ? 0.10 : 0.06), Color.accentColor.opacity(0)],
                startPoint: .top,
                endPoint: .bottom
            )
            .frame(height: 320)
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }
}

/// A solid, generously rounded card with a hairline and a soft shadow.
struct SoftCard: ViewModifier {
    var cornerRadius: CGFloat = 24
    var padding: CGFloat = 16

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(Color.softCard, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .strokeBorder(Color.softHairline, lineWidth: 1)
            )
            .shadow(color: Color.black.opacity(0.05), radius: 10, x: 0, y: 4)
    }
}

extension View {
    func softCard(cornerRadius: CGFloat = 24, padding: CGFloat = 16) -> some View {
        modifier(SoftCard(cornerRadius: cornerRadius, padding: padding))
    }

    /// A List row that is just content on the canvas: no separator, no
    /// cell background.
    func cardRow() -> some View {
        listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
    }
}

/// A friendly empty state: one big avatar and one line.
struct EmptyStateView: View {
    let slug: String
    var avatar: BotAvatar? = nil
    var mood: Mood? = .idle
    let line: String

    var body: some View {
        VStack(spacing: 14) {
            MoodAvatarView(slug: slug, avatar: avatar, mood: mood, size: 88, halo: true)
            Text(line)
                .font(.headline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 28)
        .accessibilityElement(children: .combine)
    }
}
