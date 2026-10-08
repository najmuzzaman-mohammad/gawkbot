import SwiftUI
import GawkbotKit

/// One question or approval, as a frosted card: who asks (avatar, name,
/// where it runs), what, and the options as buttons. The recommended option
/// is the filled one. Options that need words open the reply sheet.
struct AttentionCard: View {
    let item: NotchAttention
    let agent: NotchAgent?
    let selected: Bool
    let selection: Namespace.ID
    let onChoose: (InterviewOption) -> Void
    let onReply: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            VStack(alignment: .leading, spacing: 4) {
                if let title = item.title, !title.isEmpty {
                    // Verbatim: agent text is untrusted and must not become links.
                    Text(verbatim: title).font(.headline)
                }
                Text(verbatim: item.question)
                    .font(.body)
                    .foregroundStyle(item.title?.isEmpty == false ? Color.secondary : Color.primary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            options
        }
        .glassCard()
        .overlay {
            if selected {
                RoundedRectangle(cornerRadius: 24, style: .continuous)
                    .strokeBorder(Color.accentColor, lineWidth: 2)
                    .matchedGeometryEffect(id: "inbox-selection", in: selection)
            }
        }
        .scaleEffect(selected ? 1.01 : 1)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(item.displayName) asks: \(item.title ?? item.question)")
    }

    private var header: some View {
        HStack(spacing: 10) {
            MoodAvatarView(slug: item.from, mood: agent?.mood ?? .needsYou, size: 40)
                .padding(5)
                .background(.thinMaterial, in: Circle())
            VStack(alignment: .leading, spacing: 3) {
                Text(item.displayName).font(.subheadline.weight(.semibold)).lineLimit(1)
                HStack(spacing: 6) {
                    if let tag = agent?.primaryTag { TagChip(tag: tag) }
                    if let date = item.date {
                        Text(date.formatted(.relative(presentation: .named, unitsStyle: .abbreviated)))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            Spacer(minLength: 4)
            if item.blocking {
                Label("Blocking", systemImage: "exclamationmark.octagon.fill")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.red)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(Color.red.opacity(0.13), in: Capsule())
            } else {
                Text(item.isApproval ? "APPROVAL" : "QUESTION")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var options: some View {
        VStack(spacing: 8) {
            ForEach(Array(item.options.enumerated()), id: \.element.id) { index, option in
                Button { onChoose(option) } label: {
                    HStack(spacing: 8) {
                        if selected && index < 9 {
                            Text("\(index + 1)")
                                .font(.caption.monospacedDigit().weight(.semibold))
                                .foregroundStyle(.secondary)
                                .frame(width: 14)
                        }
                        if item.isRecommended(option) {
                            Image(systemName: "sparkles")
                        }
                        Text(verbatim: option.label).lineLimit(2)
                        Spacer(minLength: 0)
                        if option.requiresText == true {
                            Image(systemName: "square.and.pencil").foregroundStyle(.secondary)
                        }
                    }
                }
                .buttonStyle(OptionButtonStyle(prominent: item.isRecommended(option), destructive: option.id.lowercased().hasPrefix("reject")))
                .accessibilityHint(item.isRecommended(option) ? "Recommended" : "")
            }
            Button(action: onReply) {
                Label("Reply in your own words", systemImage: "arrowshape.turn.up.left.fill")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(OptionButtonStyle(prominent: false, destructive: false, quiet: true))
        }
    }
}

/// Generous rounded buttons. The recommended one is filled with the accent;
/// the rest are frosted. An explicit style (not .automatic) also keeps a
/// List row from turning a tap anywhere into a tap on every button.
struct OptionButtonStyle: ButtonStyle {
    let prominent: Bool
    let destructive: Bool
    var quiet = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(quiet ? Font.subheadline : Font.body.weight(prominent ? .semibold : .regular))
            .foregroundStyle(foreground)
            .padding(.horizontal, 14)
            .padding(.vertical, quiet ? 8 : 11)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(prominent ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(quiet ? Material.ultraThinMaterial : Material.thinMaterial))
            }
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .opacity(configuration.isPressed ? 0.85 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: configuration.isPressed)
    }

    private var foreground: Color {
        if prominent { return .white }
        if destructive { return .red }
        return quiet ? .secondary : .primary
    }
}

/// A roster row: avatar in its mood's loop, name, what it is doing, mood,
/// and where it came from / where it runs.
struct AgentRow: View {
    let agent: NotchAgent
    let selected: Bool

    var body: some View {
        HStack(spacing: 12) {
            MoodAvatarView(slug: agent.slug, mood: agent.mood, size: 36)
                .padding(5)
                .background(.thinMaterial, in: Circle())
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(agent.name).font(.body.weight(.semibold)).lineLimit(1)
                    if agent.isLead {
                        Image(systemName: "star.circle.fill").foregroundStyle(.yellow)
                            .accessibilityLabel("Chief of Staff")
                    }
                }
                if let detail = agent.detail, !detail.isEmpty {
                    Text(verbatim: detail).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                }
                if !agent.tags.isEmpty {
                    HStack(spacing: 4) {
                        ForEach(agent.tags, id: \.self) { TagChip(tag: $0) }
                    }
                }
            }
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 6) {
                MoodPill(mood: agent.mood)
                if selected {
                    Label("Talking to", systemImage: "mic.fill")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Color.accentColor)
                }
            }
        }
        .glassCard(cornerRadius: 20, padding: 12)
        .overlay {
            if selected {
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .strokeBorder(Color.accentColor.opacity(0.7), lineWidth: 1.5)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(agent.name), \(agent.mood.label)\(agent.detail.map { ", \($0)" } ?? "")")
    }
}
