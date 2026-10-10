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
                    MoodAvatarView(slug: "cos", mood: .working, size: 72, halo: true, showsBadge: false)
                    Text("Reaching your office…").foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.softCanvas)
            case let .failed(reason):
                VStack(spacing: 16) {
                    MoodAvatarView(slug: "cos", mood: .error, size: 72, halo: true, showsBadge: false)
                    Text("Could not reach the office").font(.headline)
                    Text(reason).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center).padding(.horizontal)
                    Button("Pair again") { store.unpair() }.buttonStyle(.borderedProminent)
                        .foregroundStyle(Color(uiColor: .systemBackground))
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.softCanvas)
            case .ready:
                MainTabView()
            }
        }
        .sheet(item: Binding(get: { store.proposedPairing.map(ProposedPairing.init) }, set: { if $0 == nil { store.proposedPairing = nil } })) { proposal in
            PairingConfirmSheet(pairing: proposal.pairing, replacesExisting: store.isPaired) {
                store.confirmProposedPairing()
            } cancel: {
                store.proposedPairing = nil
            }
            .presentationDetents([.medium])
        }
        .alert("Something went wrong", isPresented: Binding(get: { store.pairingError != nil && store.phase == .ready }, set: { if !$0 { store.pairingError = nil } })) {
            Button("OK") { store.pairingError = nil }
        } message: {
            Text(store.pairingError ?? "")
        }
        // Outermost, so the sheets above read it too: what each agent runs
        // on, for the model badge on every avatar.
        .environment(\.botRuntimes, store.runtimes)
    }
}

private struct ProposedPairing: Identifiable {
    let pairing: Pairing
    var id: String { pairing.link }
}

/// A pairing never applies itself. Whether it came from a scanned code or a
/// gawkbot:// link someone sent, the person sees where it points and taps
/// Connect — and is told when it would replace the office already paired.
struct PairingConfirmSheet: View {
    let pairing: Pairing
    let replacesExisting: Bool
    let connect: () -> Void
    let cancel: () -> Void

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Text("Connect to this office?").font(.title3.weight(.semibold))
                LabeledContent("Address", value: pairing.brokerURL.absoluteString)
                LabeledContent("Token", value: String(repeating: "•", count: 8) + pairing.token.suffix(4))
                if replacesExisting {
                    Label("This replaces the office this phone is paired with now.", systemImage: "exclamationmark.triangle")
                        .font(.footnote).foregroundStyle(.orange)
                }
                if pairing.brokerURL.scheme == "http" {
                    Text("Plain http: only use this on a network you trust (Wi‑Fi, Tailscale).")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Spacer()
                Button(action: connect) { Text("Connect").frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent).controlSize(.large)
                    .foregroundStyle(Color(uiColor: .systemBackground))
            }
            .padding()
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: cancel) } }
        }
    }
}
