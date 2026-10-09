import SwiftUI
import GawkbotKit

/// One question or approval, as a soft card: who asks (avatar, name,
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
            background
            options
        }
        .softCard()
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

    /// The background to the question. Closed, two lines of the asker's
    /// brief; tapping the card selects it, and the selected card shows all
    /// of it: the project, the task, the asker's full account, the last
    /// few lines of the conversation, and what each option would mean.
    @ViewBuilder private var background: some View {
        if selected, let brief = item.brief {
            VStack(alignment: .leading, spacing: 10) {
                if let project = brief.project, !project.isEmpty {
                    briefSection("Project") {
                        // Verbatim throughout: agent text must not become links.
                        Text(verbatim: "#\(project)").fontWeight(.semibold)
                        if let about = brief.projectAbout, !about.isEmpty { Text(verbatim: about) }
                    }
                }
                if let task = brief.task {
                    briefSection("Working on") {
                        Text(verbatim: task.title).fontWeight(.semibold)
                        if let details = task.details, !details.isEmpty { Text(verbatim: details) }
                    }
                }
                if let context = brief.context, !context.isEmpty {
                    briefSection("Why it is asking") { Text(verbatim: context) }
                }
                if let recent = brief.recent, !recent.isEmpty {
                    briefSection("Just before") {
                        ForEach(Array(recent.enumerated()), id: \.offset) { _, line in
                            (Text(verbatim: line.speaker).fontWeight(.semibold) + Text(verbatim: " " + line.text))
                        }
                    }
                }
                let described = item.options.filter { !($0.description ?? "").isEmpty }
                if !described.isEmpty {
                    briefSection("What each answer means") {
                        ForEach(described) { option in
                            (Text(verbatim: option.label).fontWeight(.semibold) + Text(verbatim: " " + (option.description ?? "")))
                        }
                    }
                }
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            .padding(.leading, 10)
            .overlay(alignment: .leading) {
                Capsule().fill(Color.secondary.opacity(0.3)).frame(width: 2)
            }
            .transition(.opacity)
            .accessibilityElement(children: .combine)
        } else if let context = item.context, !context.isEmpty {
            Text(verbatim: context)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
    }

    private func briefSection<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title.uppercased())
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.tertiary)
            content().fixedSize(horizontal: false, vertical: true)
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            MoodAvatarView(slug: item.from, avatar: agent?.avatar, mood: agent?.mood ?? .needsYou, size: 40, halo: true)
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

/// Generous rounded buttons made of glass: the recommended one is glass
/// tinted with the accent, the rest are clear glass (a refusal in red ink).
/// An explicit style (not .automatic) also keeps a List row from turning a
/// tap anywhere into a tap on every button.
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
                GlassButtonBackground(prominent: prominent, quiet: quiet, cornerRadius: 14)
            }
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            // A soft press: squash a little, spring back with some bounce.
            .scaleEffect(x: configuration.isPressed ? 0.98 : 1, y: configuration.isPressed ? 0.94 : 1)
            .opacity(configuration.isPressed ? 0.88 : 1)
            .animation(.spring(response: 0.28, dampingFraction: 0.55), value: configuration.isPressed)
    }

    private var foreground: Color {
        // The accent is monochrome (black in light, white in dark), so the
        // ink on it is the opposite end: the system background.
        if prominent { return Color(uiColor: .systemBackground) }
        if destructive { return .red }
        return quiet ? .secondary : .primary
    }
}

/// The answer buttons' material: clear glass, or glass tinted with the
/// accent for the recommended answer.
struct GlassButtonBackground: View {
    let prominent: Bool
    var quiet = false
    let cornerRadius: CGFloat

    var body: some View {
        if quiet {
            Color.clear
        } else {
            GlassLens(
                shape: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous),
                tint: prominent ? Color.accentColor : nil
            )
        }
    }
}

/// A lens of glass in any shape. On iOS 26 it is the system's Liquid Glass
/// (tinted when asked, and interactive, so it flexes under the finger).
/// Before that it is the same lens drawn by hand: a thin material so what
/// is behind shows through, the tint at partial opacity, a gloss at the
/// top, and a rim that is bright where light enters (top leading) and
/// leaves (bottom trailing).
struct GlassLens<S: InsettableShape>: View {
    let shape: S
    var tint: Color? = nil

    var body: some View {
        if #available(iOS 26.0, *) {
            shape
                .fill(Color.clear)
                .glassEffect(
                    tint.map { Glass.regular.tint($0).interactive() } ?? Glass.regular.interactive(),
                    in: shape
                )
        } else {
            ZStack {
                shape.fill(.ultraThinMaterial)
                if let tint {
                    shape.fill(tint.opacity(0.6))
                }
                shape.fill(
                    LinearGradient(
                        colors: [Color.white.opacity(0.32), Color.white.opacity(0)],
                        startPoint: .top,
                        endPoint: .center
                    )
                )
                shape.strokeBorder(
                    LinearGradient(
                        stops: [
                            .init(color: Color.white.opacity(0.85), location: 0),
                            .init(color: Color.white.opacity(0.1), location: 0.32),
                            .init(color: Color.white.opacity(0), location: 0.6),
                            .init(color: Color.white.opacity(0.45), location: 1),
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    ),
                    lineWidth: 1
                )
            }
            .shadow(color: (tint ?? Color.black).opacity(0.22), radius: 8, x: 0, y: 4)
        }
    }
}

/// A roster row: avatar in its mood's loop, name, what it is doing, mood,
/// and where it came from / where it runs.
struct AgentRow: View {
    let agent: NotchAgent
    let selected: Bool

    var body: some View {
        HStack(spacing: 12) {
            MoodAvatarView(slug: agent.slug, avatar: agent.avatar, mood: agent.mood, size: 36, halo: true)
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
        .softCard(cornerRadius: 20, padding: 12)
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
