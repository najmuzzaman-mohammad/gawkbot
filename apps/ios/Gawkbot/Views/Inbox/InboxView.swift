import SwiftUI
import GawkbotKit

/// The mobile agent inbox: every pending question from every agent
/// (blocking first), one tap to answer, swipe to approve or reply, then the
/// roster with each agent's mood. A talk bar sits underneath. Polls
/// `/notch/state` every 3 s while in front (the store does it) and on
/// pull-to-refresh.
///
/// The app only answers questions and sends messages. Whatever an answer
/// leads to still runs through the office's own approval gate.
struct InboxView: View {
    @EnvironmentObject private var store: OfficeStore
    @StateObject private var voice = VoiceRecorder()
    @Namespace private var selectionSpace

    @State private var selectedID: String?
    @State private var selectedAgent: String?
    @State private var replyTarget: ReplyTarget?
    @State private var pickedTarget: VoiceTarget?

    private var items: [NotchAttention] { store.inbox }
    private var selectedItem: NotchAttention? {
        guard let selectedID else { return nil }
        return items.first { $0.id == selectedID }
    }

    private var voiceTargets: [VoiceTarget] {
        VoiceTarget.choices(selected: selectedItem, agent: selectedAgent.flatMap { store.agent($0) }, state: store.notch)
    }

    /// Bare-key shortcuts step aside while the keyboard is typing elsewhere.
    private var shortcutsEnabled: Bool {
        replyTarget == nil && voice.phase != .confirming
    }

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                List {
                    headerSection
                    questionsSection
                    agentsSection
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .background(InboxBackdrop())
                .refreshable { await store.refreshNotch() }
                .animation(.spring(response: 0.4, dampingFraction: 0.85), value: items.map(\.id))
                .onChange(of: selectedID) { _, id in
                    guard let id else { return }
                    withAnimation(.easeInOut(duration: 0.25)) { proxy.scrollTo(id, anchor: .center) }
                }
            }
            .navigationTitle("Inbox")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Image(systemName: store.live ? "dot.radiowaves.left.and.right" : "wifi.slash")
                        .foregroundStyle(store.live ? Color.green : Color.secondary)
                        .accessibilityLabel(store.live ? "Live" : "Reconnecting")
                }
            }
            .safeAreaInset(edge: .bottom) {
                VoiceBar(voice: voice, targets: voiceTargets, picked: $pickedTarget) { text, target in
                    Task { await store.sendVoice(text, to: target) }
                }
            }
            .background {
                InboxShortcuts(enabled: shortcutsEnabled, perform: perform)
            }
            .sheet(item: $replyTarget) { target in
                ReplySheet(target: target) { text in
                    Task { await store.answer(target.attention, option: target.option, text: text) }
                }
            }
            .onChange(of: items.map(\.id)) { old, new in
                selectedID = InboxCursor.reconcile(selected: selectedID, previous: old, current: new)
            }
            .onAppear {
                let office = store
                voice.onCue = { [weak office] cue in office?.feedback.play(cue) }
            }
        }
    }

    // MARK: - Sections

    @ViewBuilder
    private var headerSection: some View {
        if let notch = store.notch {
            HStack(spacing: 14) {
                MoodAvatarView(slug: notch.lead ?? "cos", mood: notch.mood, size: 52)
                    .padding(6)
                    .background(.thinMaterial, in: Circle())
                VStack(alignment: .leading, spacing: 4) {
                    Text(notch.leadName ?? "Chief of Staff")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text(verbatim: notch.headline)
                        .font(.title3.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .glassCard()
            .cardRow()
            .accessibilityElement(children: .combine)
        } else {
            HStack {
                Spacer()
                ProgressView("Checking in with your office…")
                Spacer()
            }
            .padding(.vertical, 40)
            .cardRow()
        }
    }

    @ViewBuilder
    private var questionsSection: some View {
        if store.notch != nil {
            Section {
                if items.isEmpty {
                    allClear.cardRow()
                } else {
                    ForEach(items) { item in
                        card(for: item)
                            .id(item.id)
                            .cardRow()
                    }
                }
            } header: {
                sectionHeader(items.isEmpty ? "Needs you" : "Needs you · \(items.count)")
            }
        }
    }

    @ViewBuilder
    private var agentsSection: some View {
        if !store.agents.isEmpty {
            Section {
                ForEach(store.agents) { agent in
                    AgentRow(agent: agent, selected: selectedAgent == agent.slug)
                        .contentShape(Rectangle())
                        .onTapGesture {
                            withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                                selectedAgent = selectedAgent == agent.slug ? nil : agent.slug
                            }
                            if let slug = selectedAgent {
                                pickedTarget = .message(channel: DMChannel.slug(for: slug), agentName: agent.name)
                            }
                        }
                        .swipeActions(edge: .trailing) {
                            Button {
                                store.openChat(with: agent.slug)
                            } label: {
                                Label("Chat", systemImage: "bubble.left.fill")
                            }
                            .tint(.blue)
                        }
                        .contextMenu {
                            Button {
                                store.openChat(with: agent.slug)
                            } label: {
                                Label("Open chat", systemImage: "bubble.left.fill")
                            }
                            Button {
                                selectedAgent = agent.slug
                                pickedTarget = .message(channel: DMChannel.slug(for: agent.slug), agentName: agent.name)
                            } label: {
                                Label("Talk to \(agent.name)", systemImage: "mic.fill")
                            }
                        }
                        .cardRow()
                }
            } header: {
                sectionHeader("Agents")
            }
        }
    }

    private func sectionHeader(_ text: String) -> some View {
        Text(text)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(.secondary)
            .textCase(nil)
    }

    private var allClear: some View {
        VStack(spacing: 10) {
            MoodAvatarView(slug: store.notch?.lead ?? "cos", mood: .done, size: 56)
            Text("Nothing needs you").font(.headline)
            Text("New questions from any agent land here.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .glassCard()
    }

    private func card(for item: NotchAttention) -> some View {
        AttentionCard(
            item: item,
            agent: store.agent(item.from),
            selected: item.id == selectedID,
            selection: selectionSpace,
            onChoose: { option in choose(option, for: item) },
            onReply: { replyTarget = ReplyTarget(attention: item, option: nil) }
        )
        .contentShape(Rectangle())
        .onTapGesture { select(item.id) }
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            if let quick = item.quickOption {
                Button {
                    choose(quick, for: item)
                } label: {
                    Label(quick.label, systemImage: "checkmark.circle.fill")
                }
                .tint(.green)
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            Button {
                replyTarget = ReplyTarget(attention: item, option: nil)
            } label: {
                Label("Reply", systemImage: "arrowshape.turn.up.left.fill")
            }
            .tint(.blue)
        }
    }

    // MARK: - Actions

    private func select(_ id: String?) {
        withAnimation(.spring(response: 0.35, dampingFraction: 0.82)) { selectedID = id }
        if let item = selectedItem {
            pickedTarget = .answer(requestID: item.id, agentName: item.displayName)
        }
    }

    private func choose(_ option: InterviewOption, for item: NotchAttention) {
        if option.requiresText == true {
            replyTarget = ReplyTarget(attention: item, option: option)
        } else {
            Task { await store.answer(item, option: option, text: nil) }
        }
    }

    /// Hardware keyboard. Acting keys (1–9, Return, R) with nothing selected
    /// select the first card instead, so a stray key never answers blind.
    private func perform(_ command: InboxCommand) {
        let ids = items.map(\.id)
        switch command {
        case .next:
            select(InboxCursor.move(from: selectedID, in: ids, by: 1))
        case .previous:
            select(InboxCursor.move(from: selectedID, in: ids, by: -1))
        case let .pick(number):
            guard let item = selectedItem else { return select(ids.first) }
            if let option = item.option(shortcut: number) { choose(option, for: item) }
        case .takeRecommended:
            guard let item = selectedItem else { return select(ids.first) }
            if let option = item.recommendedOption { choose(option, for: item) }
        case .reply:
            guard let item = selectedItem else { return select(ids.first) }
            replyTarget = ReplyTarget(attention: item, option: nil)
        case .voice:
            Task { await voice.toggle() }
        case .cancel:
            if voice.isActive {
                voice.cancel()
            } else {
                select(nil)
            }
        }
    }
}

#Preview("Inbox (mock office)") {
    InboxView()
        .environmentObject(OfficeStore(credentials: MemoryCredentialStore(), forceMock: true))
}
