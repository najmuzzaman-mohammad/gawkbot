import SwiftUI
import GawkbotKit
#if canImport(VisionKit)
import VisionKit
#endif

/// First run: scan the QR code from the office's Access & Health page, or
/// type the address and token by hand.
struct PairingView: View {
    @EnvironmentObject private var store: OfficeStore
    @State private var showScanner = false
    @State private var address = ""
    @State private var token = ""
    @State private var manualError: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 28) {
                    BlobAvatarView(slug: "cos", size: 96, openness: 1)
                        .padding(.top, 32)
                    VStack(spacing: 6) {
                        Text("gawkbot").font(.system(size: 34, weight: .bold, design: .rounded))
                        Text("Text your bots like people.").foregroundStyle(.secondary)
                    }
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Pair with your office").font(.headline)
                        Text("In the office web app open **Access & Health** and scan the **Pair your phone** code. Your phone must reach the office over Wi‑Fi, Tailscale, or a share link.")
                            .font(.subheadline).foregroundStyle(.secondary)
                        if scannerAvailable {
                            Button {
                                showScanner = true
                            } label: {
                                Label("Scan pairing code", systemImage: "qrcode.viewfinder").frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.borderedProminent).controlSize(.large)
                        }
                    }
                    .padding(.horizontal)
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Or type it in").font(.headline)
                        TextField("Office address, e.g. 100.64.0.5:7890", text: $address)
                            .textFieldStyle(.roundedBorder).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                        SecureField("Token", text: $token).textFieldStyle(.roundedBorder)
                        if let manualError { Text(manualError).font(.footnote).foregroundStyle(.red) }
                        if let err = store.pairingError { Text(err).font(.footnote).foregroundStyle(.red) }
                        Button("Connect") {
                            if let p = Pairing.make(urlString: address, token: token) {
                                manualError = nil
                                store.pair(p)
                            } else {
                                manualError = "Enter the office address and the token from Access & Health."
                            }
                        }
                        .buttonStyle(.bordered).controlSize(.large).frame(maxWidth: .infinity)
                        .disabled(address.isEmpty || token.isEmpty)
                    }
                    .padding(.horizontal)
                }
                .padding(.bottom, 40)
            }
            .sheet(isPresented: $showScanner) {
                QRScannerSheet { code in
                    showScanner = false
                    store.propose(text: code)
                }
            }
        }
    }

    private var scannerAvailable: Bool {
        #if canImport(VisionKit) && !targetEnvironment(simulator)
        return DataScannerViewController.isSupported && DataScannerViewController.isAvailable
        #else
        return false
        #endif
    }
}

#if canImport(VisionKit)
struct QRScannerSheet: View {
    let onCode: (String) -> Void
    var body: some View {
        NavigationStack {
            QRScanner(onCode: onCode)
                .ignoresSafeArea()
                .navigationTitle("Scan pairing code")
                .navigationBarTitleDisplayMode(.inline)
        }
    }
}

struct QRScanner: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let vc = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced, isHighlightingEnabled: true)
        vc.delegate = context.coordinator
        try? vc.startScanning()
        return vc
    }

    func updateUIViewController(_ uiViewController: DataScannerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onCode: (String) -> Void
        private var fired = false
        init(onCode: @escaping (String) -> Void) { self.onCode = onCode }
        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            guard !fired else { return }
            for item in addedItems {
                // Only the shape the office's Access & Health card produces.
                // The person still confirms the target host before anything
                // connects (PairingConfirmSheet).
                if case let .barcode(code) = item, let payload = code.payloadStringValue, payload.hasPrefix(Pairing.scheme + "://pair?") {
                    fired = true
                    dataScanner.stopScanning()
                    onCode(payload)
                    return
                }
            }
        }
    }
}
#else
struct QRScannerSheet: View {
    let onCode: (String) -> Void
    var body: some View { Text("Scanning is not available on this device.") }
}
#endif
