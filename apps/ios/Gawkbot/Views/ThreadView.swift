import SwiftUI
import GawkbotKit

/// One bot's DM, laid out like an iMessage thread on the soft canvas: a big
/// avatar hero at the top (tap "Change look" to pick its shape and colour),
/// the bot's soft neutral bubbles on the left with its avatar at the start
/// of each run, yours on the right in the accent, office notices centred,
/// asks as cards with buttons, a typing bubble while the bot works, and a
/// composer pinned above the keyboard. Hold the composer's mic to talk: the
/// words land in the message box, and nothing goes until you tap Send.
struct ThreadView: View {
    @EnvironmentObject private var store: OfficeStore
    let channel: String
    @State private var draft = ""
    @State private var pickingLook = false
    @StateObject private var voice = VoiceRecorder()
    /// Shown briefly after a tap on the mic that was too short to talk.
    @State private var holdHint = false
    @FocusState private var composing: Bool

    private var bot: Bot? { store.bot(for: channel) }
    private var slug: String { bot?.slug ?? DMChannel.bot(in: channel) ?? "" }
    private var name: String { bot?.name ?? channel }
    private var avatar: BotAvatar? { store.avatar(for: slug) }
    private var agent: NotchAgent? { store.agent(slug) }
    private var messages: [ChatMessage] { store.messages[channel] ?? [] }
    private var typing: Bool { store.typing.contains(slug) }
    private var asks: [BotRequest] { store.requests(in: channel) }
    /// A terminal session kept as a member. It cannot be messaged from here.
    private var isSession: Bool { bot?.isSession ?? agent?.isSession ?? false }
    /// For a session, only what its own log says; never the office's activity.
    private var working: Bool { isSession ? bot?.sessionStatus == .working : typing }
    private var heroMood: Mood {
        if isSession { return working ? .working : .idle }
        return typing ? .working : (agent?.mood ?? .idle)
    }
    private var emptyLine: String {
        (bot ?? Bot(slug: slug, name: name, origin: isSession ? SessionMember.origin : nil)).emptyConversationLine
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 2) {
                    ThreadHero(
                        slug: slug,
                        name: name,
                        spokenName: store.runtimes.spokenName(name, slug: slug),
                        avatar: avatar,
                        mood: heroMood,
                        subtitle: heroSubtitle,
                        onChangeLook: { if !slug.isEmpty { pickingLook = true } }
                    )
                    if messages.isEmpty && asks.isEmpty && !typing {
                        Text(verbatim: emptyLine)
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
            .onDisappear {
                if store.openThread == channel { store.openThread = nil }
                voice.cancel()
            }
        }
        .safeAreaInset(edge: .bottom) {
            // No message box and no mic for a session: one sentence instead.
            if isSession { sessionNotice } else { composer }
        }
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                // Room under the avatar for the badge tucked into its corner.
                VStack(spacing: 4) {
                    WorkingBlobAvatarView(slug: slug, avatar: avatar, size: 26, working: working)
                    Text(verbatim: name).font(.caption2).foregroundStyle(.primary)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel(store.runtimes.spokenName(name, slug: slug))
            }
        }
        .onAppear {
            let office = store
            voice.onCue = { [weak office] cue in office?.feedback.play(cue) }
        }
        .onChange(of: voice.phase) { _, phase in
            if phase == .confirming { takeTranscript() }
        }
        .voiceProblemAlert(voice)
        .sheet(isPresented: $pickingLook) {
            AvatarPickerSheet(slug: slug, name: name, current: avatar) { picked in
                await store.updateAvatar(slug: slug, to: picked)
            }
        }
    }

    private var heroSubtitle: String? {
        if isSession, let bot {
            return [bot.sessionStatusLabel, bot.sessionProject].filter { !$0.isEmpty }.joined(separator: " · ")
        }
        if typing { return "typing…" }
        if let detail = agent?.detail, !detail.isEmpty { return detail }
        if let role = bot?.role, !role.isEmpty { return role }
        return agent?.mood.label
    }

    /// Where the composer would be for a session member. A closed session
    /// is not told it is open.
    private var sessionNotice: some View {
        Label(bot?.sessionNotMessageable ?? SessionMember.notMessageable, systemImage: "terminal")
            .font(.footnote)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(.bar)
            .accessibilityElement(children: .combine)
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            if voice.isActive {
                VoiceTranscriptStrip(voice: voice)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            } else if holdHint {
                Label("Hold the mic to talk, let go to finish.", systemImage: "mic.fill")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 4)
                    .transition(.opacity)
            }
            // One row in every voice phase, so the mic's press gesture
            // survives the state changes it causes.
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Message \(name)", text: $draft, axis: .vertical)
                    .lineLimit(1...6)
                    .focused($composing)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(Color.softCard, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(Color.softHairline, lineWidth: 1))
                    .onSubmit(send)
                HoldToTalkButton(voice: voice) { showHoldHint() }
                Button(action: send) {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 32))
                        .foregroundStyle(canSend ? Color.accentColor : Color(.tertiaryLabel))
                }
                .disabled(!canSend)
                .accessibilityLabel("Send")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
        .animation(.spring(response: 0.35, dampingFraction: 0.85), value: voice.phase)
        .animation(.easeInOut(duration: 0.2), value: holdHint)
    }

    /// The recorder finished: put what it heard in the message box, after
    /// anything already typed. Sending stays a tap on Send.
    private func takeTranscript() {
        let heard = voice.transcript
        voice.reset()
        guard !heard.isEmpty else { return }
        let typed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        draft = typed.isEmpty ? heard : typed + " " + heard
    }

    private func showHoldHint() {
        holdHint = true
        Task {
            try? await Task.sleep(for: .seconds(2.5))
            holdHint = false
        }
    }

    private var canSend: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    private func send() {
        guard canSend, !isSession else { return }
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
    /// The name as VoiceOver reads it, with what the agent runs on.
    var spokenName: String? = nil
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
                .accessibilityLabel(spokenName ?? name)
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
