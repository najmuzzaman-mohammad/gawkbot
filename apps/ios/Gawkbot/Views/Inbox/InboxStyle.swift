import SwiftUI
import GawkbotKit

// Shared look for the inbox: frosted cards over a soft colour wash, tag
// chips, and mood pills. System materials and semantic colours only, so it
// follows light and dark mode on its own.

/// Soft blurred colour behind the glass so the material has something to
/// frost. Static (no motion), so Reduce Motion has nothing to turn off.
struct InboxBackdrop: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let strength = scheme == .dark ? 0.32 : 0.20
        ZStack {
            Color(.systemGroupedBackground)
            Circle()
                .fill(Color.accentColor.opacity(strength))
                .frame(width: 340, height: 340)
                .blur(radius: 90)
                .offset(x: -130, y: -280)
            Circle()
                .fill(Color.orange.opacity(strength * 0.9))
                .frame(width: 300, height: 300)
                .blur(radius: 100)
                .offset(x: 150, y: 20)
            Circle()
                .fill(Color.purple.opacity(strength * 0.8))
                .frame(width: 280, height: 280)
                .blur(radius: 110)
                .offset(x: -80, y: 360)
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }
}

/// A frosted, generously rounded card.
struct GlassCard: ViewModifier {
    var cornerRadius: CGFloat = 24
    var padding: CGFloat = 16

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.18), lineWidth: 0.5)
            )
            .shadow(color: Color.black.opacity(0.08), radius: 12, x: 0, y: 6)
    }
}

extension View {
    func glassCard(cornerRadius: CGFloat = 24, padding: CGFloat = 16) -> some View {
        modifier(GlassCard(cornerRadius: cornerRadius, padding: padding))
    }

    /// A List row that is just a card on the backdrop: no separator, no
    /// cell background.
    func cardRow() -> some View {
        listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
    }
}

struct TagChip: View {
    let tag: AgentTag

    var body: some View {
        HStack(spacing: 3) {
            if tag.style == .elsewhere {
                Image(systemName: "cloud.fill").imageScale(.small)
            }
            Text(tag.text).lineLimit(1)
        }
        .font(.caption2.weight(.semibold))
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .foregroundStyle(foreground)
        .background(background, in: Capsule())
    }

    private var foreground: Color {
        switch tag.style {
        case .yours: return .accentColor
        case .elsewhere: return .teal
        case .neutral: return .secondary
        }
    }

    private var background: Color {
        switch tag.style {
        case .yours: return Color.accentColor.opacity(0.15)
        case .elsewhere: return Color.teal.opacity(0.15)
        case .neutral: return Color.secondary.opacity(0.12)
        }
    }
}

extension Mood {
    var tint: Color {
        switch self {
        case .needsYou: return .orange
        case .working: return .blue
        case .idle: return .gray
        case .error: return .red
        case .done: return .green
        }
    }

    var symbol: String {
        switch self {
        case .needsYou: return "hand.raised.fill"
        case .working: return "ellipsis.circle.fill"
        case .idle: return "moon.zzz.fill"
        case .error: return "exclamationmark.triangle.fill"
        case .done: return "checkmark.seal.fill"
        }
    }
}

struct MoodPill: View {
    let mood: Mood

    var body: some View {
        Label(mood.label, systemImage: mood.symbol)
            .font(.caption.weight(.semibold))
            .labelStyle(.titleAndIcon)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .foregroundStyle(mood.tint)
            .background(mood.tint.opacity(0.14), in: Capsule())
    }
}

extension SoundCue {
    var symbol: String {
        switch self {
        case .newQuestion: return "questionmark.bubble.fill"
        case .approvalNeeded: return "hand.raised.fill"
        case .error: return "exclamationmark.triangle.fill"
        case .done: return "party.popper.fill"
        case .sent: return "paperplane.fill"
        case .voiceStart: return "mic.fill"
        case .voiceStop: return "mic.slash.fill"
        }
    }
}
