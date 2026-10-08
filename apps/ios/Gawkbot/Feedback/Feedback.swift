import AVFoundation
import UIKit
import GawkbotKit

/// UserDefaults keys for the Settings toggles. Both default to on.
enum FeedbackKeys {
    static let sounds = "gawkbot.sounds.enabled"
    static let haptics = "gawkbot.haptics.enabled"

    static func isOn(_ key: String) -> Bool {
        UserDefaults.standard.object(forKey: key) as? Bool ?? true
    }
}

/// One-off haptics for touches that are not inbox events (squishing an
/// avatar). Honour the same Settings toggle as `FeedbackPlayer`.
enum Haptics {
    @MainActor
    static func lightTap() {
        guard FeedbackKeys.isOn(FeedbackKeys.haptics) else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }
}

/// A sound and a haptic per event, each behind its own Settings toggle.
@MainActor
final class FeedbackPlayer {
    private let engine: CartoonSoundEngine

    init() {
        engine = CartoonSoundEngine()
    }

    /// Sound and haptic.
    func play(_ cue: SoundCue) {
        playSound(cue)
        playHaptic(cue)
    }

    func playSound(_ cue: SoundCue) {
        guard FeedbackKeys.isOn(FeedbackKeys.sounds) else { return }
        engine.play(cue)
    }

    /// Settings' "try it" rows: plays even with sounds switched off.
    func preview(_ cue: SoundCue) {
        engine.play(cue)
        playHaptic(cue)
    }

    func playHaptic(_ cue: SoundCue) {
        guard FeedbackKeys.isOn(FeedbackKeys.haptics) else { return }
        switch cue {
        case .newQuestion: UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        case .approvalNeeded: UINotificationFeedbackGenerator().notificationOccurred(.warning)
        case .error: UINotificationFeedbackGenerator().notificationOccurred(.error)
        case .done: UINotificationFeedbackGenerator().notificationOccurred(.success)
        case .sent: UIImpactFeedbackGenerator(style: .light).impactOccurred()
        case .voiceStart: UIImpactFeedbackGenerator(style: .soft).impactOccurred()
        case .voiceStop: UIImpactFeedbackGenerator(style: .rigid).impactOccurred()
        }
    }
}

/// Plays `CartoonSynth`'s generated samples through one AVAudioPlayerNode.
/// Nothing is bundled: each cue is rendered once, on first use, into a
/// PCM buffer and cached.
///
/// The session is `.ambient`: the sounds mix with whatever is playing and
/// the ring/silent switch mutes them. While the voice recorder holds the
/// session for recording, cues are skipped rather than fighting it.
@MainActor
final class CartoonSoundEngine {
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let format = AVAudioFormat(standardFormatWithSampleRate: CartoonSynth.sampleRate, channels: 1)
    private var cache: [SoundCue: AVAudioPCMBuffer] = [:]
    private var wired = false

    func play(_ cue: SoundCue) {
        guard let format, let buffer = buffer(for: cue, format: format) else { return }
        let session = AVAudioSession.sharedInstance()
        if session.category == .record || session.category == .playAndRecord { return }
        if session.category != .ambient {
            try? session.setCategory(.ambient, mode: .default, options: [])
        }
        try? session.setActive(true)
        if !wired {
            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: format)
            wired = true
        }
        // A route or category change stops the engine; start it again here
        // rather than tracking AVAudioEngineConfigurationChange.
        if !engine.isRunning {
            engine.prepare()
            do { try engine.start() } catch { return }
        }
        // The newest cue cuts off the previous one instead of queueing.
        player.scheduleBuffer(buffer, at: nil, options: .interrupts, completionHandler: nil)
        if !player.isPlaying { player.play() }
    }

    private func buffer(for cue: SoundCue, format: AVAudioFormat) -> AVAudioPCMBuffer? {
        if let hit = cache[cue] { return hit }
        let samples = CartoonSynth.render(cue, sampleRate: format.sampleRate)
        guard !samples.isEmpty,
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)),
              let channels = buffer.floatChannelData
        else { return nil }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        let out = channels[0]
        for i in 0..<samples.count { out[i] = samples[i] }
        cache[cue] = buffer
        return buffer
    }
}
