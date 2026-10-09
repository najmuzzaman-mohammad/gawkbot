import SwiftUI
import GawkbotKit

/// The talk bar pinned under the inbox. Hold the mic to talk; the
/// transcript shows live; let go and you get Send / Cancel. It never sends
/// on its own. The "To" menu picks where the words go: the selected
/// question, the selected agent, or the Chief of Staff.
struct VoiceBar: View {
    @ObservedObject var voice: VoiceRecorder
    let targets: [VoiceTarget]
    @Binding var picked: VoiceTarget?
    let onSend: (String, VoiceTarget) -> Void

    /// True while a finger is down on the mic; keeps one start per press.
    @State private var holding = false

    /// The picked target while it is still on offer, else the best one.
    private var target: VoiceTarget? {
        if let picked, targets.contains(picked) { return picked }
        return targets.first
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if voice.phase == .listening || voice.phase == .finishing {
                transcriptView
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            if voice.phase == .confirming {
                confirmView
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            } else {
                // Same view in idle, starting, listening and finishing, so the
                // mic's press gesture survives the state changes it causes.
                HStack(spacing: 12) {
                    targetMenu
                    Spacer(minLength: 4)
                    Text(hint)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    micButton
                }
            }
        }
        .padding(12)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .strokeBorder(Color.white.opacity(0.18), lineWidth: 0.5)
        )
        .shadow(color: Color.black.opacity(0.12), radius: 16, x: 0, y: 8)
        .padding(.horizontal, 12)
        .padding(.bottom, 6)
        .animation(.spring(response: 0.35, dampingFraction: 0.85), value: voice.phase)
        .alert(item: $voice.problem) { problem in
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

    private var hint: String {
        switch voice.phase {
        case .idle: return "Hold to talk"
        case .starting: return "Getting ready…"
        case .listening: return "Let go to finish"
        case .finishing: return "Finishing…"
        case .confirming: return ""
        }
    }

    private var targetMenu: some View {
        Menu {
            ForEach(targets) { t in
                Button {
                    picked = t
                } label: {
                    if t == target {
                        Label(t.label, systemImage: "checkmark")
                    } else {
                        Text(t.label)
                    }
                }
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: target.map(icon(for:)) ?? "person.fill")
                Text(target?.label ?? "Chief of Staff").lineLimit(1)
                Image(systemName: "chevron.up.chevron.down").imageScale(.small)
            }
            .font(.subheadline.weight(.semibold))
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(.thinMaterial, in: Capsule())
        }
        .disabled(voice.isActive)
        .accessibilityLabel("Send voice to: \(target?.label ?? "Chief of Staff")")
    }

    private func icon(for target: VoiceTarget) -> String {
        switch target {
        case .answer: return "questionmark.bubble.fill"
        case .message: return "bubble.left.fill"
        }
    }

    private var transcriptView: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "waveform")
                .foregroundStyle(Color.accentColor)
                .symbolEffect(.variableColor.iterative, isActive: voice.phase == .listening)
            Text(voice.transcript.isEmpty ? "Listening…" : voice.transcript)
                .font(.body)
                .foregroundStyle(voice.transcript.isEmpty ? Color.secondary : Color.primary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .lineLimit(5)
            if voice.phase == .finishing {
                ProgressView().controlSize(.small)
            }
        }
        .padding(10)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private var confirmView: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(target?.label ?? "Chief of Staff", systemImage: target.map(icon(for:)) ?? "person.fill")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            TextField("Didn't catch that. Try again, or type here.", text: $voice.transcript, axis: .vertical)
                .lineLimit(1...6)
                .padding(10)
                .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            HStack {
                Button("Cancel", role: .cancel) { voice.cancel() }
                    .buttonStyle(.bordered)
                    .keyboardShortcut(.cancelAction)
                Spacer()
                Button {
                    let text = voice.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
                    if let target, !text.isEmpty {
                        onSend(text, target)
                    }
                    voice.reset()
                } label: {
                    Label("Send", systemImage: "arrow.up.circle.fill")
                }
                .buttonStyle(.borderedProminent)
                .foregroundStyle(Color(uiColor: .systemBackground))
                .keyboardShortcut(.defaultAction)
                .disabled(voice.transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || target == nil)
            }
        }
    }

    private var micButton: some View {
        let live = voice.phase == .listening
        return ZStack {
            MicLevelRing(meter: voice.meter, active: live)
            // A glass lens tinted with the accent, red while it listens.
            GlassLens(shape: Circle(), tint: live ? Color.red : Color.accentColor)
                .frame(width: 52, height: 52)
            Image(systemName: live ? "waveform" : "mic.fill")
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(live ? Color.white : Color(uiColor: .systemBackground))
        }
        .frame(width: 64, height: 64)
        .scaleEffect(holding ? 1.08 : 1)
        .contentShape(Circle())
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { _ in
                    guard !holding else { return }
                    holding = true
                    Task { await voice.start() }
                }
                .onEnded { _ in
                    holding = false
                    voice.stop()
                }
        )
        .accessibilityElement()
        .accessibilityLabel(live ? "Stop talking" : "Talk")
        .accessibilityHint("Hold to talk and let go to finish. With VoiceOver, double-tap to start and again to stop.")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { Task { await voice.toggle() } }
    }
}

/// A soft ring that swells with the mic level. Observes only the meter, so
/// the level updates redraw just this ring.
private struct MicLevelRing: View {
    @ObservedObject var meter: VoiceMeter
    let active: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Circle()
            .fill(Color.red.opacity(active ? 0.22 : 0))
            .frame(width: 52, height: 52)
            .scaleEffect(active && !reduceMotion ? 1 + CGFloat(meter.level) * 0.45 : 1)
            .animation(.easeOut(duration: 0.12), value: meter.level)
    }
}
