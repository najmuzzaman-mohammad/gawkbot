import SwiftUI
import GawkbotKit

/// The message box an agent's thread and the Chief of Staff box on the inbox
/// share: a growing text field, the hold-to-talk mic, and Send. Hold the mic
/// to talk: the words land in the field, after anything already typed, and
/// nothing goes until Send is tapped. The owner decides where the text goes
/// and what sits behind the box.
struct MessageComposer: View {
    @EnvironmentObject private var store: OfficeStore
    /// Who the message is for, as the placeholder reads it.
    let name: String
    /// What the field sits on decides its fill: a card on a bar, a quiet
    /// fill on a card.
    var fieldFill: Color = .softCard
    var focused: FocusState<Bool>.Binding
    let onSend: (String) -> Void

    @State private var draft = ""
    @StateObject private var voice = VoiceRecorder()
    /// A short line above the box: hold the mic (after a tap), or nothing
    /// was heard. Clears itself.
    @State private var voiceHint: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if voice.isActive {
                VoiceTranscriptStrip(voice: voice)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            } else if let voiceHint {
                Label(voiceHint, systemImage: "mic.fill")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 4)
                    .transition(.opacity)
            }
            // One row in every voice phase, so the mic's press gesture
            // survives the state changes it causes.
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Message \(name)", text: $draft, axis: .vertical)
                    .lineLimit(1...6)
                    .focused(focused)
                    .accessibilityIdentifier("composer")
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(fieldFill, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(Color.softHairline, lineWidth: 1))
                    .onSubmit(send)
                HoldToTalkButton(voice: voice) { showVoiceHint("Hold the mic to talk, let go to finish.") }
                Button(action: send) {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 32))
                        .foregroundStyle(canSend ? Color.accentColor : Color(.tertiaryLabel))
                }
                .disabled(!canSend)
                .accessibilityLabel("Send")
            }
        }
        .animation(.spring(response: 0.35, dampingFraction: 0.85), value: voice.phase)
        .animation(.easeInOut(duration: 0.2), value: voiceHint)
        .onAppear {
            let office = store
            voice.onCue = { [weak office] cue in office?.feedback.play(cue) }
        }
        .onDisappear { voice.cancel() }
        .onChange(of: voice.phase) { _, phase in
            if phase == .confirming { takeTranscript() }
        }
        .voiceProblemAlert(voice)
    }

    /// The recorder finished: put what it heard in the message box, after
    /// anything already typed. Sending stays a tap on Send.
    private func takeTranscript() {
        let heard = voice.transcript
        voice.reset()
        guard !heard.isEmpty else {
            showVoiceHint("Didn't catch that. Hold the mic and try again.")
            return
        }
        let typed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        draft = typed.isEmpty ? heard : typed + " " + heard
    }

    private func showVoiceHint(_ text: String) {
        voiceHint = text
        Task {
            try? await Task.sleep(for: .seconds(2.5))
            if voiceHint == text { voiceHint = nil }
        }
    }

    private var canSend: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    private func send() {
        guard canSend else { return }
        let text = draft
        draft = ""
        #if os(iOS)
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        #endif
        onSend(text)
    }
}
