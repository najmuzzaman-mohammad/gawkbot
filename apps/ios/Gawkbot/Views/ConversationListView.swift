import SwiftUI
import GawkbotKit

/// The Agents tab, a Messages-style list: one row per bot, Chief of Staff pinned first,
/// last line as preview, unread badge on the left like iMessage. Terminal
/// sessions open on the Mac are members too, but they are not the office's
/// agents: they get their own section below, and it is absent when there
/// are none.
struct ConversationListView: View {
    @EnvironmentObject private var store: OfficeStore
    @State private var path: [String] = []

    var body: some View {
        let groups = SessionMember.group(store.bots)
        NavigationStack(path: $path) {
            List {
                if store.bots.isEmpty {
                    EmptyStateView(slug: "cos", mood: .idle, line: "No agents yet. Hire one in the office and it shows up here.")
                        .cardRow()
                }
                ForEach(groups.agents) { bot in
                    row(bot)
                }
                if !groups.sessions.isEmpty {
                    Section {
                        ForEach(groups.sessions) { bot in
                            row(bot)
                        }
                    } header: {
                        Text(SessionMember.sectionTitle)
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .textCase(nil)
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Color.softCanvas)
            .navigationTitle("Agents")
            .navigationDestination(for: String.self) { channel in
                ThreadView(channel: channel)
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        if !store.isMock {
                            Button(role: .destructive) { store.unpair() } label: { Label("Unpair this phone", systemImage: "xmark.circle") }
                        }
                        Label(store.live ? "Live" : "Reconnecting…", systemImage: store.live ? "dot.radiowaves.left.and.right" : "wifi.slash")
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
            }
            .refreshable { await store.refresh() }
            .onChange(of: store.openThread) { _, channel in
                if let channel, !path.contains(channel) { path.append(channel) }
            }
            .onAppear {
                if let channel = store.openThread, path.isEmpty { path = [channel] }
            }
        }
    }

    private func row(_ bot: Bot) -> some View {
        NavigationLink(value: bot.dmChannel) {
            ConversationRow(bot: bot)
        }
        .listRowInsets(EdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 16))
        .listRowBackground(Color.clear)
        .listRowSeparatorTint(Color.softHairline)
    }
}

struct ConversationRow: View {
    @EnvironmentObject private var store: OfficeStore
    let bot: Bot

    private var last: ChatMessage? { store.lastMessage(bot.dmChannel) }
    private var unread: Int { store.unread[bot.dmChannel] ?? 0 }
    private var typing: Bool { store.typing.contains(bot.slug) }
    private var pendingAsk: Bool { !store.requests(in: bot.dmChannel).isEmpty }
    /// A session's avatar works when its own log says so, never because the
    /// office reports activity for it.
    private var working: Bool { bot.isSession ? bot.sessionStatus == .working : typing }

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            ZStack {
                Circle().fill(Color.accentColor).frame(width: 10, height: 10).opacity(unread > 0 ? 1 : 0)
            }
            .frame(width: 12)
            // No tap-squish here: the row is a NavigationLink and the tap is its.
            WorkingBlobAvatarView(slug: bot.slug, avatar: store.avatar(for: bot.slug), size: 44, working: working, halo: true)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(bot.name).font(.body.weight(.semibold)).lineLimit(1)
                    Spacer()
                    Text(timeLabel).font(.footnote).foregroundStyle(.secondary)
                }
                if bot.isSession {
                    sessionLine
                }
                if !preview.isEmpty {
                    HStack(spacing: 4) {
                        if pendingAsk {
                            Image(systemName: "questionmark.circle.fill").foregroundStyle(.orange).font(.footnote)
                        }
                        Text(preview)
                            .font(.subheadline)
                            .foregroundStyle(Color.secondary)
                            .lineLimit(2)
                            .italic(typing && !bot.isSession)
                    }
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(spokenLabel)
    }

    /// The folder a session works in and its status, from the session alone.
    private var sessionLine: some View {
        HStack(spacing: 6) {
            SessionStatusChip(status: bot.sessionStatus)
            if !bot.sessionProject.isEmpty {
                HStack(spacing: 3) {
                    Image(systemName: "folder").imageScale(.small)
                    Text(verbatim: bot.sessionProject).lineLimit(1)
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
        }
    }

    private var spokenLabel: String {
        var parts = [store.runtimes.spokenName(bot.name, slug: bot.slug) + (unread > 0 ? ", \(unread) unread" : "")]
        if bot.isSession {
            parts.append(bot.sessionStatusLabel)
            if !bot.sessionProject.isEmpty { parts.append("In the \(bot.sessionProject) folder") }
        }
        if !preview.isEmpty { parts.append(preview) }
        return parts.joined(separator: ". ")
    }

    private var preview: String {
        // A session row says only what the session says: no typing line, no
        // role, no "No messages yet". Its last message still shows.
        if bot.isSession {
            guard let last else { return "" }
            return (last.isFromHuman ? "You: " : "") + last.content.replacingOccurrences(of: "\n", with: " ")
        }
        if typing { return "\(bot.name) is typing…" }
        if pendingAsk, let ask = store.requests(in: bot.dmChannel).first { return "Needs your call: \(ask.title ?? ask.question)" }
        guard let last else { return bot.role ?? "No messages yet" }
        let prefix = last.isFromHuman ? "You: " : ""
        return prefix + last.content.replacingOccurrences(of: "\n", with: " ")
    }

    private var timeLabel: String {
        guard let d = last?.date else { return "" }
        let cal = Calendar.current
        if cal.isDateInToday(d) { return d.formatted(date: .omitted, time: .shortened) }
        if cal.isDateInYesterday(d) { return "Yesterday" }
        if let days = cal.dateComponents([.day], from: d, to: Date()).day, days < 7 { return d.formatted(.dateTime.weekday(.wide)) }
        return d.formatted(date: .numeric, time: .omitted)
    }
}

/// A session's status as a small chip: "Working", "Your turn", "Quiet", or
/// "Closed". Colour only where it means something: working, and waiting on
/// the person.
struct SessionStatusChip: View {
    let status: SessionStatus

    var body: some View {
        Text(status.label)
            .font(.caption2.weight(.semibold))
            .lineLimit(1)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .foregroundStyle(tint)
            .background(tint.opacity(0.14), in: Capsule())
    }

    private var tint: Color {
        switch status {
        case .working: return Mood.working.tint
        case .yourTurn: return Mood.needsYou.tint
        case .quiet, .closed: return .secondary
        }
    }
}
