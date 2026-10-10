import SwiftUI
import GawkbotKit

/// The Chief of Staff's own block, pinned to the bottom of the inbox whether
/// or not anything is waiting: who it is and what the office is up to, the
/// last line or two of your conversation, and a message box that sends into
/// its DM exactly as its thread does. Tap the top to open the whole thread.
/// It is never part of a list of agents.
struct ChiefOfStaffBox: View {
    @EnvironmentObject private var store: OfficeStore
    @Environment(\.dynamicTypeSize) private var typeSize
    let lead: OfficeStore.Lead
    var focused: FocusState<Bool>.Binding

    private var agent: NotchAgent? { store.agent(lead.slug) }
    private var typing: Bool { store.typing.contains(lead.slug) }
    private var mood: Mood { typing ? .working : (agent?.mood ?? .idle) }

    /// The office in one line, as the Chief of Staff tells it.
    private var status: String {
        if typing { return "typing…" }
        if let headline = store.notch?.headline, !headline.isEmpty { return headline }
        if let detail = agent?.detail, !detail.isEmpty { return detail }
        return mood.label
    }

    /// The last bubbles of the DM, already loaded for its thread. One at the
    /// largest text sizes, so the box stays a box.
    private var recent: [ChatMessage] {
        let said = (store.messages[lead.channel] ?? []).filter { !$0.rendersAsSystemLine }
        return Array(said.suffix(typeSize.isAccessibilitySize ? 1 : 2))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                focused.wrappedValue = false
                store.openChat(in: lead.channel)
            } label: {
                VStack(alignment: .leading, spacing: 8) {
                    header
                    ForEach(recent) { message in
                        line(message)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(spokenSummary)
            .accessibilityHint("Opens the conversation")
            MessageComposer(name: lead.name, fieldFill: .softFill, focused: focused) { text in
                Task { await store.send(text, to: lead.channel) }
            }
        }
        .softCard(padding: 12)
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .background { fade }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(lead.name)
    }

    private var header: some View {
        HStack(spacing: 10) {
            // No tap-squish here: the header is a button and the tap is its.
            MoodAvatarView(slug: lead.slug, avatar: store.avatar(for: lead.slug), mood: mood, size: 40, halo: true, squishOnTap: false)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: lead.name)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Text(verbatim: status)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .italic(typing)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
    }

    /// One past message as a quiet line. Verbatim: bot output is untrusted.
    private func line(_ message: ChatMessage) -> some View {
        Text(verbatim: preview(message))
            .font(.subheadline)
            .foregroundStyle(message.isFromHuman ? Color.secondary : Color.primary)
            .lineLimit(2)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func preview(_ message: ChatMessage) -> String {
        (message.isFromHuman ? "You: " : "") + message.content.replacingOccurrences(of: "\n", with: " ")
    }

    private var spokenSummary: String {
        ([store.runtimes.spokenName(lead.name, slug: lead.slug), status] + recent.map(preview)).joined(separator: ". ")
    }

    /// The canvas behind the box, fading in at the top so the cards that
    /// scroll under it do not show round its edges.
    private var fade: some View {
        LinearGradient(
            stops: [
                .init(color: Color.softCanvas.opacity(0), location: 0),
                .init(color: Color.softCanvas, location: 0.12),
            ],
            startPoint: .top,
            endPoint: .bottom
        )
        .ignoresSafeArea(edges: .bottom)
        .accessibilityHidden(true)
    }
}
