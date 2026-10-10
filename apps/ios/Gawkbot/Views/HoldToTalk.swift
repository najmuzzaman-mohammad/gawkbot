import SwiftUI
import GawkbotKit

/// The mic in an agent's composer. Hold it to talk, let go to finish; the
/// thread puts the transcript in the message box. It never sends anything.
struct HoldToTalkButton: View {
    @ObservedObject var voice: VoiceRecorder
    /// The finger lifted before any listening began (a tap, not a hold).
    let onTap: () -> Void

    /// True while a finger is down on the mic. A GestureState, not a State:
    /// it resets when the system cancels the touch (the permission prompt
    /// on first use, a call, Control Center), where `onEnded` never runs.
    @GestureState private var pressing = false
    /// This press already started the recorder; keeps one start per press.
    @State private var started = false

    private let size: CGFloat = 34

    var body: some View {
        let live = voice.phase == .listening
        ZStack {
            MicLevelRing(meter: voice.meter, active: live, size: size)
            // The same glass lens as the answer buttons, red while it listens.
            GlassLens(shape: Circle(), tint: live ? Color.red : nil)
                .frame(width: size, height: size)
            Image(systemName: live ? "waveform" : "mic.fill")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(live ? Color.white : Color.accentColor)
        }
        .frame(width: size, height: size)
        .scaleEffect(pressing ? 1.15 : 1)
        .animation(.spring(response: 0.28, dampingFraction: 0.6), value: pressing)
        .contentShape(Circle().inset(by: -6))
        .gesture(
            DragGesture(minimumDistance: 0)
                .updating($pressing) { _, state, _ in state = true }
        )
        .onChange(of: pressing) { _, down in
            if down {
                guard !started else { return }
                started = true
                Task { await voice.start() }
            } else {
                // Lifted, or the touch was cancelled: either way, stop.
                started = false
                if voice.phase != .listening { onTap() }
                voice.stop()
            }
        }
        .accessibilityElement()
        .accessibilityIdentifier("holdToTalk")
        .accessibilityLabel(live ? "Stop talking" : "Talk")
        .accessibilityHint("Hold to talk and let go to finish. With VoiceOver, double-tap to start and again to stop.")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { Task { await voice.toggle() } }
    }
}

/// What is being heard, live, above the composer while the mic is held.
struct VoiceTranscriptStrip: View {
    @ObservedObject var voice: VoiceRecorder

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "waveform")
                .foregroundStyle(Color.accentColor)
                .symbolEffect(.variableColor.iterative, isActive: voice.phase == .listening)
            Text(voice.transcript.isEmpty ? placeholder : voice.transcript)
                .font(.body)
                .foregroundStyle(voice.transcript.isEmpty ? Color.secondary : Color.primary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .lineLimit(5)
            if voice.phase == .finishing {
                ProgressView().controlSize(.small)
            }
        }
        .padding(10)
        .background(Color.softCard, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private var placeholder: String {
        switch voice.phase {
        case .starting: return "Getting ready…"
        case .finishing: return "Finishing…"
        default: return "Listening… let go to finish"
        }
    }
}

/// A soft ring that swells with the mic level. Observes only the meter, so
/// the level updates redraw just this ring.
private struct MicLevelRing: View {
    @ObservedObject var meter: VoiceMeter
    let active: Bool
    let size: CGFloat
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Circle()
            .fill(Color.red.opacity(active ? 0.22 : 0))
            .frame(width: size, height: size)
            .scaleEffect(active && !reduceMotion ? 1 + CGFloat(meter.level) * 0.6 : 1)
            .animation(.easeOut(duration: 0.12), value: meter.level)
    }
}

extension View {
    /// Permission refusals and microphone failures from the recorder, with a
    /// jump to Settings when that is what fixes it.
    func voiceProblemAlert(_ voice: VoiceRecorder) -> some View {
        modifier(VoiceProblemAlert(voice: voice))
    }
}

private struct VoiceProblemAlert: ViewModifier {
    @ObservedObject var voice: VoiceRecorder

    func body(content: Content) -> some View {
        content.alert(item: $voice.problem) { problem in
            if problem.offerSettings, let url = URL(string: UIApplication.openSettingsURLString) {
                return Alert(
                    title: Text("Voice is off"),
                    message: Text(problem.message),
                    primaryButton: .default(Text("Open Settings")) { UIApplication.shared.open(url) },
                    secondaryButton: .cancel(Text("Not now"))
                )
            }
            return Alert(title: Text("Voice"), message: Text(problem.message), dismissButton: .default(Text("OK")))
        }
    }
}
