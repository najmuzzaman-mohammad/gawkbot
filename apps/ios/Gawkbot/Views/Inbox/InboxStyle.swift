import SwiftUI
import GawkbotKit

// Shared pieces for the inbox: tag chips and mood pills. The soft canvas,
// cards and `cardRow()` live in Views/Theme.swift.

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
