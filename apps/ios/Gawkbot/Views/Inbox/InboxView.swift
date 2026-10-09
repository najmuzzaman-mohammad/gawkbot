import SwiftUI
import GawkbotKit

/// The mobile agent inbox: every pending question from every agent
/// (blocking first), one tap to answer, swipe to approve or reply. Only
/// what is waiting on you lives here; the agents themselves, and talking
/// to them, are in the Agents tab. Polls `/notch/state` every 3 s while in
/// front (the store does it) and on pull-to-refresh.
///
/// The app only answers questions and sends messages. Whatever an answer
/// leads to still runs through the office's own approval gate.
struct InboxView: View {
    @EnvironmentObject private var store: OfficeStore
    @Namespace private var selectionSpace

    @State private var selectedID: String?
    @State private var replyTarget: ReplyTarget?

    private var items: [NotchAttention] { store.inbox }
    private var selectedItem: NotchAttention? {
        guard let selectedID else { return nil }
        return items.first { $0.id == selectedID }
    }

    /// Bare-key shortcuts step aside while the reply sheet is typing.
    private var shortcutsEnabled: Bool { replyTarget == nil }

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                List {
                    headerSection
                    questionsSection
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .background(SoftBackdrop())
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
            .background {
                InboxShortcuts(enabled: shortcutsEnabled, perform: perform)
            }
            .sheet(item: $replyTarget) { target in
                ReplySheet(target: target, avatar: store.avatar(for: target.attention.from)) { text in
                    Task { await store.answer(target.attention, option: target.option, text: text) }
                }
            }
            .onChange(of: items.map(\.id)) { old, new in
                selectedID = InboxCursor.reconcile(selected: selectedID, previous: old, current: new)
            }
        }
    }

    // MARK: - Sections

    @ViewBuilder
    private var headerSection: some View {
        if let notch = store.notch {
            HStack(spacing: 14) {
                MoodAvatarView(slug: notch.lead ?? "cos", avatar: store.avatar(for: notch.lead ?? "cos"), mood: notch.mood, size: 56, halo: true)
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
            .softCard()
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

    private func sectionHeader(_ text: String) -> some View {
        Text(text)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(.secondary)
            .textCase(nil)
    }

    private var allClear: some View {
        let lead = store.notch?.lead ?? "cos"
        return EmptyStateView(slug: lead, avatar: store.avatar(for: lead), mood: .done, line: "Nothing needs you right now.")
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
        case .cancel:
            select(nil)
        }
    }
}

#Preview("Inbox (mock office)") {
    InboxView()
        .environmentObject(OfficeStore(credentials: MemoryCredentialStore(), forceMock: true))
}
