import SwiftUI
import GawkbotKit

// The model badge: what an agent runs on, on every agent avatar. The rules
// (how much it says at each avatar size, the two-character code, the spoken
// title) are `BotRuntime` in GawkbotKit, ported from the web and tested
// there. This file only draws it.
//
// The avatar views in BlobAvatarView.swift apply `modelBadge` themselves, so
// a call site cannot forget it. The runtime comes from the environment by
// slug; with none known for a slug nothing is drawn.

private struct BotRuntimesKey: EnvironmentKey {
    static let defaultValue = BotRuntimeLookup.none
}

extension EnvironmentValues {
    /// Each agent's runtime by slug. Set once at the root from OfficeStore.
    var botRuntimes: BotRuntimeLookup {
        get { self[BotRuntimesKey.self] }
        set { self[BotRuntimesKey.self] = newValue }
    }
}

/// The tag itself: "Opus 5.5" where there is room, "Opus" or "Op" where
/// there is less, a dot where there is none.
struct ModelBadgeView: View {
    let runtime: BotRuntime
    /// Size of the avatar the badge sits on; it decides how much is spelled out.
    let avatarSize: CGFloat

    /// Follows Dynamic Type the way the caption-sized chips do, held to a
    /// ceiling so the tag never grows over the face it sits on.
    @ScaledMetric(relativeTo: .caption2) private var typeScale: CGFloat = 1

    private var density: BadgeDensity { BotRuntime.badgeDensity(avatarSize: Double(avatarSize)) }
    private var scale: CGFloat { min(max(typeScale, 1), ModelBadgeView.maxTypeScale) }

    static let maxTypeScale: CGFloat = 1.35
    static let dotSize: CGFloat = 6

    var body: some View {
        if density == .dot {
            Circle()
                .fill(Color.primary)
                .frame(width: ModelBadgeView.dotSize, height: ModelBadgeView.dotSize)
        } else {
            let m = ModelBadgeView.metrics(for: density)
            let fontSize = m.fontSize * scale
            Text(verbatim: runtime.badgeText(density))
                .font(.system(size: fontSize, weight: .semibold))
                .lineLimit(1)
                // A label a little too long for the cap shrinks before it
                // is cut: "GPT-6 Astra" stays whole under a list avatar.
                .minimumScaleFactor(0.8)
                .truncationMode(.tail)
                .foregroundStyle(Color.primary)
                .padding(.horizontal, m.padding)
                .frame(minWidth: m.minWidth * scale, maxWidth: maxWidth(m, fontSize: fontSize))
                .frame(height: m.height * scale)
                .background(Color.softCard, in: Capsule())
                .overlay(Capsule().strokeBorder(Color.primary.opacity(0.16), lineWidth: 1))
                .fixedSize()
        }
    }

    /// The widest the tag may be: a character budget like the web's, and
    /// never much wider than the avatar, so a long raw model id ends in an
    /// ellipsis and stays clear of the row beside it.
    private func maxWidth(_ m: Metrics, fontSize: CGFloat) -> CGFloat {
        guard m.maxCharacters > 0 else { return .infinity }
        let budget = CGFloat(m.maxCharacters) * fontSize * 0.6 + m.padding * 2
        return min(budget, avatarSize * 1.6)
    }

    struct Metrics {
        var fontSize: CGFloat
        var height: CGFloat
        var padding: CGFloat
        var minWidth: CGFloat
        /// 0: no cap (a code is two characters).
        var maxCharacters: Int
    }

    static func metrics(for density: BadgeDensity) -> Metrics {
        switch density {
        case .dot: return Metrics(fontSize: 0, height: dotSize, padding: 0, minWidth: dotSize, maxCharacters: 0)
        case .code: return Metrics(fontSize: 9, height: 13, padding: 3, minWidth: 16, maxCharacters: 0)
        case .word: return Metrics(fontSize: 10, height: 15, padding: 5, minWidth: 0, maxCharacters: 9)
        case .full: return Metrics(fontSize: 10, height: 16, padding: 6, minWidth: 0, maxCharacters: 14)
        }
    }
}

private struct ModelBadgeOverlay: ViewModifier {
    let slug: String
    let avatarSize: CGFloat
    let shows: Bool

    @Environment(\.botRuntimes) private var runtimes

    private var density: BadgeDensity { BotRuntime.badgeDensity(avatarSize: Double(avatarSize)) }

    /// Small avatars tuck the tag into the bottom-trailing corner; larger
    /// ones centre it under the face.
    private var tucked: Bool { density == .dot || density == .code }

    private var nudge: CGSize {
        switch density {
        case .dot: return CGSize(width: 2, height: 2)
        case .code: return CGSize(width: 5, height: 4)
        case .word: return CGSize(width: 0, height: 6)
        case .full: return CGSize(width: 0, height: 7)
        }
    }

    func body(content: Content) -> some View {
        content.overlay(alignment: tucked ? .bottomTrailing : .bottom) {
            if shows, let runtime = runtimes[slug] {
                ModelBadgeView(runtime: runtime, avatarSize: avatarSize)
                    .offset(nudge)
                    .allowsHitTesting(false)
            }
        }
    }
}

extension View {
    /// Draws the model badge for `slug` over an avatar of `size`, when the
    /// office says what that agent runs on. Used by the avatar views only.
    func modelBadge(slug: String, size: CGFloat, shows: Bool) -> some View {
        modifier(ModelBadgeOverlay(slug: slug, avatarSize: size, shows: shows))
    }
}
