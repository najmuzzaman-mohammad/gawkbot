import SwiftUI
import GawkbotKit

@main
struct GawkbotApp: App {
    @StateObject private var store: OfficeStore

    init() {
        let args = ProcessInfo.processInfo.arguments
        let env = ProcessInfo.processInfo.environment
        let mock = args.contains("-mock") || env["GAWKBOT_MOCK"] == "1"
        let store = OfficeStore(credentials: KeychainCredentialStore(), forceMock: mock)
        #if DEBUG
        // Debug-build automation for simulators (screenshots, end-to-end
        // checks): pair without the confirmation sheet, open a thread, send a
        // line. Launch arguments cannot be set by anything on a real phone.
        store.applyDebugLaunchArguments(args)
        #endif
        _store = StateObject(wrappedValue: store)
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .onOpenURL { url in store.handle(url: url) }
        }
    }
}
