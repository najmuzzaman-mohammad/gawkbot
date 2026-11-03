import SwiftUI
import GawkbotKit

enum AppTab: Hashable {
    case inbox
    case agents
    case settings
}

/// The paired app: the inbox first (everything waiting on you), then the
/// agents (one thread each, where you type or talk), then settings. Drives the inbox poll
/// from the scene phase so it only runs while the app is in front.
struct MainTabView: View {
    @EnvironmentObject private var store: OfficeStore
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        TabView(selection: $store.tab) {
            InboxView()
                .tabItem { Label("Inbox", systemImage: "tray.full.fill") }
                .badge(store.inbox.count)
                .tag(AppTab.inbox)
            ConversationListView()
                .tabItem { Label("Agents", systemImage: "person.2.fill") }
                .badge(store.totalUnread)
                .tag(AppTab.agents)
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape.fill") }
                .tag(AppTab.settings)
        }
        .onAppear {
            store.setForeground(scenePhase == .active)
            if store.openThread != nil { store.tab = .agents }
        }
        .onDisappear { store.setForeground(false) }
        .onChange(of: scenePhase) { _, phase in
            store.setForeground(phase == .active)
        }
        .onChange(of: store.openThread) { _, channel in
            if channel != nil { store.tab = .agents }
        }
    }
}
