import SwiftUI
import GawkbotKit

@main
struct GawkbotApp: App {
    @StateObject private var store: OfficeStore

    init() {
        let args = ProcessInfo.processInfo.arguments
        let env = ProcessInfo.processInfo.environment
        let mock = args.contains("-mock") || env["GAWKBOT_MOCK"] == "1"
        _store = StateObject(wrappedValue: OfficeStore(credentials: KeychainCredentialStore(), forceMock: mock))
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .onOpenURL { url in store.handle(url: url) }
        }
    }
}
