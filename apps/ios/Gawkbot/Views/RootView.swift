import SwiftUI
import GawkbotKit

struct RootView: View {
    @EnvironmentObject private var store: OfficeStore

    var body: some View {
        Group {
            switch store.phase {
            case .unpaired:
                PairingView()
            case .connecting:
                VStack(spacing: 12) {
                    ProgressView()
                    Text("Reaching your office…").foregroundStyle(.secondary)
                }
            case let .failed(reason):
                VStack(spacing: 16) {
                    Image(systemName: "wifi.exclamationmark").font(.system(size: 40)).foregroundStyle(.secondary)
                    Text("Could not reach the office").font(.headline)
                    Text(reason).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center).padding(.horizontal)
                    Button("Pair again") { store.unpair() }.buttonStyle(.borderedProminent)
                }
            case .ready:
                ConversationListView()
            }
        }
        .alert("Something went wrong", isPresented: Binding(get: { store.pairingError != nil && store.phase == .ready }, set: { if !$0 { store.pairingError = nil } })) {
            Button("OK") { store.pairingError = nil }
        } message: {
            Text(store.pairingError ?? "")
        }
    }
}
