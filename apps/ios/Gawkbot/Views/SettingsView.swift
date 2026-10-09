import SwiftUI
import GawkbotKit

/// Sounds and haptics, the office connection, and the way into the
/// keyboard reference.
struct SettingsView: View {
    @EnvironmentObject private var store: OfficeStore
    @AppStorage(FeedbackKeys.sounds) private var soundsOn = true
    @AppStorage(FeedbackKeys.haptics) private var hapticsOn = true

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle(isOn: $soundsOn) {
                        Label("Sounds", systemImage: "speaker.wave.2.fill")
                    }
                    Toggle(isOn: $hapticsOn) {
                        Label("Haptics", systemImage: "iphone.radiowaves.left.and.right")
                    }
                } header: {
                    Text("Feedback")
                } footer: {
                    Text("A different little sound for each kind of event, made on the phone as it plays. They mix with your music and stay quiet when the switch is on silent.")
                }

                Section("Office") {
                    LabeledContent("Address", value: store.officeAddress)
                    LabeledContent("Connection") {
                        // Not a Label: as a row's value, a Label is laid out as
                        // a list row of its own and stretches the row.
                        HStack(spacing: 6) {
                            Image(systemName: store.live ? "dot.radiowaves.left.and.right" : "wifi.slash")
                            Text(store.live ? "Live" : "Reconnecting…")
                        }
                        .foregroundStyle(store.live ? Color.green : Color.secondary)
                    }
                    if !store.isMock {
                        Button(role: .destructive) {
                            store.unpair()
                        } label: {
                            Label("Unpair this phone", systemImage: "xmark.circle")
                        }
                    }
                }

                Section {
                    NavigationLink {
                        KeyboardShortcutsView()
                    } label: {
                        Label("Keyboard shortcuts", systemImage: "keyboard")
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color.softCanvas)
            .navigationTitle("Settings")
        }
    }
}

/// The hardware-keyboard reference, opened from Settings.
struct KeyboardShortcutsView: View {
    var body: some View {
        Form {
            Section {
                ForEach(InboxKeymap.help) { line in
                    LabeledContent(line.action) {
                        Text(line.keys)
                            .font(.callout.monospaced())
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color.softFill, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                    }
                }
            } footer: {
                Text("With a hardware keyboard, in the Inbox. ⌘V and other ⌘ shortcuts are left alone.")
            }
        }
        .scrollContentBackground(.hidden)
        .background(Color.softCanvas)
        .navigationTitle("Keyboard shortcuts")
        .navigationBarTitleDisplayMode(.inline)
    }
}
