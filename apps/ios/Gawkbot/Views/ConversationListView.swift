import SwiftUI
import GawkbotKit

/// The Messages-style list: one row per bot, Chief of Staff pinned first,
/// last line as preview, unread badge on the left like iMessage.
struct ConversationListView: View {
    @EnvironmentObject private var store: OfficeStore
    @State private var path: [String] = []

    var body: some View {
        NavigationStack(path: $path) {
            List {
                ForEach(store.bots) { bot in
                    NavigationLink(value: bot.dmChannel) {
                        ConversationRow(bot: bot)
                    }
                    .listRowInsets(EdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 16))
                }
            }
            .listStyle(.plain)
            .navigationTitle("Bots")
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
}

struct ConversationRow: View {
    @EnvironmentObject private var store: OfficeStore
    let bot: Bot

    private var last: ChatMessage? { store.lastMessage(bot.dmChannel) }
    private var unread: Int { store.unread[bot.dmChannel] ?? 0 }
    private var typing: Bool { store.typing.contains(bot.slug) }
    private var pendingAsk: Bool { !store.requests(in: bot.dmChannel).isEmpty }

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            ZStack {
                Circle().fill(Color.accentColor).frame(width: 10, height: 10).opacity(unread > 0 ? 1 : 0)
            }
            .frame(width: 12)
            WorkingBlobAvatarView(slug: bot.slug, size: 48, working: typing)
                .padding(4)
                .background(Circle().fill(Color(.secondarySystemBackground)))
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(bot.name).font(.body.weight(.semibold)).lineLimit(1)
                    Spacer()
                    Text(timeLabel).font(.footnote).foregroundStyle(.secondary)
                }
                HStack(spacing: 4) {
                    if pendingAsk {
                        Image(systemName: "questionmark.circle.fill").foregroundStyle(.orange).font(.footnote)
                    }
                    Text(preview)
                        .font(.subheadline)
                        .foregroundStyle(typing ? Color.secondary : Color.secondary)
                        .lineLimit(2)
                        .italic(typing)
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(bot.name)\(unread > 0 ? ", \(unread) unread" : ""). \(preview)")
    }

    private var preview: String {
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
