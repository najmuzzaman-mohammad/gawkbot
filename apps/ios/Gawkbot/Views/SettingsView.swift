import SwiftUI
import GawkbotKit

/// Sounds and haptics, the office connection, and the keyboard reference.
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

                Section("Hear them") {
                    ForEach(SoundCue.allCases, id: \.self) { cue in
                        Button {
                            store.feedback.preview(cue)
                        } label: {
                            Label(cue.title, systemImage: cue.symbol)
                        }
                    }
                }

                Section("Office") {
                    LabeledContent("Address", value: store.officeAddress)
                    LabeledContent("Connection") {
                        Label(store.live ? "Live" : "Reconnecting…", systemImage: store.live ? "dot.radiowaves.left.and.right" : "wifi.slash")
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
                    ForEach(InboxKeymap.help) { line in
                        LabeledContent(line.action) {
                            Text(line.keys)
                                .font(.callout.monospaced())
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                        }
                    }
                } header: {
                    Text("Keyboard shortcuts")
                } footer: {
                    Text("With a hardware keyboard, in the Inbox. Hold ⌘ on iPad to see them. ⌘V and other ⌘ shortcuts are left alone.")
                }
            }
            .navigationTitle("Settings")
        }
    }
}
