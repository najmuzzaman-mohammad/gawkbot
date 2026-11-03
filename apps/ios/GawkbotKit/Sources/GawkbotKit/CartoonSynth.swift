import Foundation

/// One sound per kind of event. Every one is synthesized from sine and
/// triangle tones at runtime; the app bundles no audio files.
public enum SoundCue: String, CaseIterable, Hashable, Sendable {
    /// A bouncy "boing".
    case newQuestion
    /// A two-note ascending "doo-dee".
    case approvalNeeded
    /// A descending "wah-wah".
    case error
    /// A bright "ta-da" arpeggio.
    case done
    /// A soft "pop".
    case sent
    /// Tiny blips around talking.
    case voiceStart
    case voiceStop

    /// Lower plays first when several events land in one poll.
    public var priority: Int {
        switch self {
        case .approvalNeeded: return 0
        case .newQuestion: return 1
        case .error: return 2
        case .done: return 3
        case .sent: return 4
        case .voiceStart: return 5
        case .voiceStop: return 6
        }
    }
}

/// A tiny additive synth: each cue is a handful of tones, each with an
/// exponential pitch glide, optional vibrato, a short linear attack and a
/// curved decay to silence. Renders mono Float samples in [-1, 1]; the app
/// copies them into an AVAudioPCMBuffer.
public enum CartoonSynth {
    public static let sampleRate: Double = 44_100

    public enum Wave: Sendable {
        case sine
        case triangle
    }

    public struct Tone: Sendable {
        /// Seconds from the start of the cue.
        public var start: Double
        public var duration: Double
        /// Pitch glides exponentially from `from` to `to` (Hz).
        public var from: Double
        public var to: Double
        public var wave: Wave
        public var gain: Double
        public var attack: Double
        /// Exponent of the decay curve (1 linear, higher = snappier).
        public var decay: Double
        public var vibratoRate: Double
        /// Fraction of the pitch, fading out over the tone.
        public var vibratoDepth: Double

        public init(start: Double, duration: Double, from: Double, to: Double? = nil, wave: Wave = .triangle, gain: Double = 0.5, attack: Double = 0.005, decay: Double = 2, vibratoRate: Double = 0, vibratoDepth: Double = 0) {
            self.start = start
            self.duration = duration
            self.from = from
            self.to = to ?? from
            self.wave = wave
            self.gain = gain
            self.attack = attack
            self.decay = decay
            self.vibratoRate = vibratoRate
            self.vibratoDepth = vibratoDepth
        }
    }

    // Note frequencies used below.
    static let c5 = 523.25, d5 = 587.33, e5 = 659.25, g5 = 783.99, a5 = 880.0, c6 = 1046.5

    public static func tones(for cue: SoundCue) -> [Tone] {
        switch cue {
        case .newQuestion:
            // A spring: a fast rising glide with a wobble that settles.
            return [
                Tone(start: 0, duration: 0.34, from: 190, to: 560, gain: 0.6, decay: 1.6, vibratoRate: 17, vibratoDepth: 0.09),
                Tone(start: 0, duration: 0.30, from: 380, to: 1120, wave: .sine, gain: 0.16, decay: 2, vibratoRate: 17, vibratoDepth: 0.09),
            ]
        case .approvalNeeded:
            return [
                Tone(start: 0, duration: 0.16, from: d5, gain: 0.5, decay: 1.5),
                Tone(start: 0, duration: 0.16, from: d5 * 2, wave: .sine, gain: 0.12, decay: 2),
                Tone(start: 0.17, duration: 0.28, from: a5, gain: 0.5, decay: 1.6),
                Tone(start: 0.17, duration: 0.28, from: a5 * 2, wave: .sine, gain: 0.12, decay: 2),
            ]
        case .error:
            // Two sagging notes, the second longer and lower: "wah… wahhh".
            return [
                Tone(start: 0, duration: 0.24, from: 311, to: 293, gain: 0.55, decay: 1.4, vibratoRate: 7, vibratoDepth: 0.025),
                Tone(start: 0.26, duration: 0.50, from: 262, to: 196, gain: 0.55, decay: 1.3, vibratoRate: 6, vibratoDepth: 0.035),
            ]
        case .done:
            return [
                Tone(start: 0.00, duration: 0.14, from: c5, gain: 0.36, decay: 1.6),
                Tone(start: 0.08, duration: 0.14, from: e5, gain: 0.36, decay: 1.6),
                Tone(start: 0.16, duration: 0.16, from: g5, gain: 0.36, decay: 1.6),
                Tone(start: 0.24, duration: 0.52, from: c6, gain: 0.40, decay: 1.3),
                Tone(start: 0.24, duration: 0.40, from: c6 * 2, wave: .sine, gain: 0.08, decay: 2, vibratoRate: 6, vibratoDepth: 0.004),
            ]
        case .sent:
            return [
                Tone(start: 0, duration: 0.07, from: 760, to: 240, wave: .sine, gain: 0.6, attack: 0.002, decay: 3),
            ]
        case .voiceStart:
            return [
                Tone(start: 0, duration: 0.055, from: 880, to: 1320, wave: .sine, gain: 0.35, attack: 0.003, decay: 2),
            ]
        case .voiceStop:
            return [
                Tone(start: 0, duration: 0.055, from: 1320, to: 880, wave: .sine, gain: 0.35, attack: 0.003, decay: 2),
            ]
        }
    }

    /// The cue's samples, peak-limited to 0.8 so it never clips.
    public static func render(_ cue: SoundCue, sampleRate: Double = CartoonSynth.sampleRate) -> [Float] {
        let parts = tones(for: cue)
        let end = parts.map { $0.start + $0.duration }.max() ?? 0
        let count = Int((end + 0.01) * sampleRate)
        guard count > 0, sampleRate > 0 else { return [] }
        var out = [Float](repeating: 0, count: count)

        for tone in parts where tone.duration > 0 && tone.from > 0 && tone.to > 0 {
            let first = Int(tone.start * sampleRate)
            let length = Int(tone.duration * sampleRate)
            var phase = 0.0
            for i in 0..<length {
                let index = first + i
                if index >= count { break }
                let t = Double(i) / sampleRate
                let u = t / tone.duration
                var freq = tone.from * pow(tone.to / tone.from, u)
                if tone.vibratoDepth > 0 {
                    freq *= 1 + tone.vibratoDepth * sin(2 * Double.pi * tone.vibratoRate * t) * (1 - u)
                }
                phase += freq / sampleRate
                phase -= floor(phase)
                let wave: Double
                switch tone.wave {
                case .sine: wave = sin(2 * Double.pi * phase)
                case .triangle: wave = phase < 0.5 ? 4 * phase - 1 : 3 - 4 * phase
                }
                let attack = min(1, t / max(tone.attack, 0.0001))
                let decay = pow(max(0, 1 - u), tone.decay)
                out[index] += Float(wave * tone.gain * attack * decay)
            }
        }

        var peak: Float = 0
        for s in out { peak = max(peak, abs(s)) }
        if peak > 0.8 {
            let g = 0.8 / peak
            for i in out.indices { out[i] *= g }
        }
        return out
    }
}
