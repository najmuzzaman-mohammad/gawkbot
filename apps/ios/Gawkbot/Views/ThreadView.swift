import SwiftUI
import GawkbotKit

/// One bot's DM, laid out like an iMessage thread: gray bubbles on the left
/// for the bot, blue on the right for you, system lines centered, asks as
/// cards with buttons, a typing bubble while the bot works, and a composer
/// pinned above the keyboard.
struct ThreadView: View {
    @EnvironmentObject private var store: OfficeStore
    let channel: String
    @State private var draft = ""
    @FocusState private var composing: Bool

    private var bot: Bot? { store.bot(for: channel) }
    private var messages: [ChatMessage] { store.messages[channel] ?? [] }
    private var typing: Bool { bot.map { store.typing.contains($0.slug) } ?? false }
    private var asks: [BotRequest] { store.requests(in: channel) }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 2) {
                    ForEach(Array(messages.enumerated()), id: \.element.id) { idx, msg in
                        let prev = idx > 0 ? messages[idx - 1] : nil
                        if showsTimestamp(msg, after: prev) {
                            TimestampLabel(date: msg.date).padding(.vertical, 10)
                        }
                        MessageRow(message: msg, botSlug: bot?.slug ?? "", isTail: isTail(idx))
                            .id(msg.id)
                    }
                    ForEach(asks) { ask in
                        RequestCardView(request: ask, botName: bot?.name ?? ask.from) { choice, text in
                            Task { await store.answer(ask, choice: choice, text: text) }
                        }
                        .id(ask.id)
                        .padding(.top, 6)
                    }
                    if typing, let bot {
                        TypingBubble(slug: bot.slug).id("typing").padding(.top, 4)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal, 12)
                .padding(.top, 8)
            }
            .scrollDismissesKeyboard(.interactively)
            .defaultScrollAnchor(.bottom)
            .onChange(of: messages.count) { _, _ in scrollToBottom(proxy) }
            .onChange(of: typing) { _, _ in scrollToBottom(proxy) }
            .onChange(of: asks.count) { _, _ in scrollToBottom(proxy) }
            .onAppear {
                store.openThread = channel
                store.markRead(channel)
                scrollToBottom(proxy, animated: false)
            }
            .onDisappear { if store.openThread == channel { store.openThread = nil } }
        }
        .safeAreaInset(edge: .bottom) { composer }
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 2) {
                    WorkingBlobAvatarView(slug: bot?.slug ?? "", size: 30, working: typing)
                    Text(bot?.name ?? channel).font(.caption2).foregroundStyle(.primary)
                }
                .accessibilityElement(children: .combine)
            }
        }
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Message \(bot?.name ?? "")", text: $draft, axis: .vertical)
                .lineLimit(1...6)
                .focused($composing)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Color(.separator), lineWidth: 1))
                .onSubmit(send)
            Button(action: send) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 30))
                    .foregroundStyle(canSend ? Color.accentColor : Color(.tertiaryLabel))
            }
            .disabled(!canSend)
            .accessibilityLabel("Send")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
    }

    private var canSend: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    private func send() {
        guard canSend else { return }
        let text = draft
        draft = ""
        #if os(iOS)
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        #endif
        Task { await store.send(text, to: channel) }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool = true) {
        let action = { proxy.scrollTo("bottom", anchor: .bottom) }
        if animated { withAnimation(.easeOut(duration: 0.25), action) } else { action() }
    }

    /// iMessage shows a timestamp when more than an hour passed since the previous bubble.
    private func showsTimestamp(_ msg: ChatMessage, after prev: ChatMessage?) -> Bool {
        guard let d = msg.date else { return false }
        guard let p = prev?.date else { return true }
        return d.timeIntervalSince(p) > 3600
    }

    /// The last bubble in a run from the same sender gets the tail.
    private func isTail(_ idx: Int) -> Bool {
        guard idx + 1 < messages.count else { return true }
        return messages[idx + 1].from != messages[idx].from
    }
}

struct TimestampLabel: View {
    let date: Date?
    var body: some View {
        if let date {
            Text(label(date)).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
        }
    }
    private func label(_ d: Date) -> String {
        let cal = Calendar.current
        if cal.isDateInToday(d) { return "Today " + d.formatted(date: .omitted, time: .shortened) }
        if cal.isDateInYesterday(d) { return "Yesterday " + d.formatted(date: .omitted, time: .shortened) }
        return d.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day().hour().minute())
    }
}
