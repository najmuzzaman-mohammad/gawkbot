import SwiftUI
import GawkbotKit

/// One bot's DM, laid out like an iMessage thread on the soft canvas: a big
/// avatar hero at the top (tap "Change look" to pick its shape and colour),
/// the bot's soft neutral bubbles on the left with its avatar at the start
/// of each run, yours on the right in the accent, office notices centred,
/// asks as cards with buttons, a typing bubble while the bot works, and a
/// composer pinned above the keyboard.
struct ThreadView: View {
    @EnvironmentObject private var store: OfficeStore
    let channel: String
    @State private var draft = ""
    @State private var pickingLook = false
    @FocusState private var composing: Bool

    private var bot: Bot? { store.bot(for: channel) }
    private var slug: String { bot?.slug ?? DMChannel.bot(in: channel) ?? "" }
    private var name: String { bot?.name ?? channel }
    private var avatar: BotAvatar? { store.avatar(for: slug) }
    private var agent: NotchAgent? { store.agent(slug) }
    private var messages: [ChatMessage] { store.messages[channel] ?? [] }
    private var typing: Bool { store.typing.contains(slug) }
    private var asks: [BotRequest] { store.requests(in: channel) }
    private var heroMood: Mood { typing ? .working : (agent?.mood ?? .idle) }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 2) {
                    ThreadHero(
                        slug: slug,
                        name: name,
                        avatar: avatar,
                        mood: heroMood,
                        subtitle: heroSubtitle,
                        onChangeLook: { if !slug.isEmpty { pickingLook = true } }
                    )
                    if messages.isEmpty && asks.isEmpty && !typing {
                        Text(verbatim: "Say hi. \(name) answers right here, like a person would.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: .infinity)
                            .padding(.top, 4)
                    }
                    ForEach(Array(messages.enumerated()), id: \.element.id) { idx, msg in
                        let prev = idx > 0 ? messages[idx - 1] : nil
                        if showsTimestamp(msg, after: prev) {
                            TimestampLabel(date: msg.date).padding(.vertical, 10)
                        }
                        MessageRow(
                            message: msg,
                            avatar: store.avatar(for: msg.from),
                            isRunStart: isRunStart(idx),
                            isTail: isTail(idx)
                        )
                        .id(msg.id)
                    }
                    ForEach(asks) { ask in
                        RequestCardView(request: ask, botName: name) { choice, text in
                            Task { await store.answer(ask, choice: choice, text: text) }
                        }
                        .id(ask.id)
                        .padding(.top, 6)
                    }
                    if typing, !slug.isEmpty {
                        TypingBubble(slug: slug, avatar: avatar).id("typing").padding(.top, 6)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal, 12)
                .padding(.top, 8)
            }
            .scrollDismissesKeyboard(.interactively)
            .defaultScrollAnchor(.bottom)
            .background(Color.softCanvas)
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
                    WorkingBlobAvatarView(slug: slug, avatar: avatar, size: 26, working: typing)
                    Text(verbatim: name).font(.caption2).foregroundStyle(.primary)
                }
                .accessibilityElement(children: .combine)
            }
        }
        .sheet(isPresented: $pickingLook) {
            AvatarPickerSheet(slug: slug, name: name, current: avatar) { picked in
                await store.updateAvatar(slug: slug, to: picked)
            }
        }
    }

    private var heroSubtitle: String? {
        if typing { return "typing…" }
        if let detail = agent?.detail, !detail.isEmpty { return detail }
        if let role = bot?.role, !role.isEmpty { return role }
        return agent?.mood.label
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Message \(name)", text: $draft, axis: .vertical)
                .lineLimit(1...6)
                .focused($composing)
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .background(Color.softCard, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(Color.softHairline, lineWidth: 1))
                .onSubmit(send)
            Button(action: send) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 32))
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

    /// Two bubbles are one run when the same sender sent them back to back,
    /// with no notice or timestamp between.
    private func continuesRun(_ idx: Int) -> Bool {
        guard idx > 0, idx < messages.count else { return false }
        let prev = messages[idx - 1]
        let cur = messages[idx]
        return prev.from == cur.from
            && !prev.rendersAsSystemLine
            && !cur.rendersAsSystemLine
            && !showsTimestamp(cur, after: prev)
    }

    /// The first bubble in a run gets the avatar.
    private func isRunStart(_ idx: Int) -> Bool { !continuesRun(idx) }

    /// The last bubble in a run gets the tail.
    private func isTail(_ idx: Int) -> Bool { !continuesRun(idx + 1) }
}

/// The top of a thread: the bot big, squishy and in its mood, its name, what
/// it is up to, and the way into the look picker.
struct ThreadHero: View {
    let slug: String
    let name: String
    let avatar: BotAvatar?
    let mood: Mood
    let subtitle: String?
    let onChangeLook: () -> Void

    var body: some View {
        VStack(spacing: 8) {
            MoodAvatarView(slug: slug, avatar: avatar, mood: mood, size: 88, halo: true)
                .padding(.bottom, 2)
            Text(verbatim: name)
                .font(.title2.weight(.bold))
                .multilineTextAlignment(.center)
            if let subtitle {
                Text(verbatim: subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
            }
            Button(action: onChangeLook) {
                Label("Change look", systemImage: "paintpalette.fill")
                    .font(.footnote.weight(.semibold))
            }
            .buttonStyle(.bordered)
            .buttonBorderShape(.capsule)
            .controlSize(.small)
            .padding(.top, 4)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 16)
        .padding(.bottom, 18)
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
