import Foundation

/// How an avatar sits at one instant. Offsets are fractions of the avatar's
/// size; rotation is in degrees; scale anchors at the avatar's feet.
public struct MoodPose: Equatable, Sendable {
    public var dx: Double
    public var dy: Double
    public var rotation: Double
    public var scaleX: Double
    public var scaleY: Double
    /// Eye openness, 1 wide, 0 narrowed (a blink).
    public var openness: Double

    public static let rest = MoodPose(dx: 0, dy: 0, rotation: 0, scaleX: 1, scaleY: 1, openness: 1)

    public init(dx: Double = 0, dy: Double = 0, rotation: Double = 0, scaleX: Double = 1, scaleY: Double = 1, openness: Double = 1) {
        self.dx = dx
        self.dy = dy
        self.rotation = rotation
        self.scaleX = scaleX
        self.scaleY = scaleY
        self.openness = openness
    }

    /// Two poses layered: offsets and rotation add, scales multiply, and the
    /// eyes take whichever is more closed. `.rest` is the identity.
    public func combined(with other: MoodPose) -> MoodPose {
        MoodPose(
            dx: dx + other.dx,
            dy: dy + other.dy,
            rotation: rotation + other.rotation,
            scaleX: scaleX * other.scaleX,
            scaleY: scaleY * other.scaleY,
            openness: min(openness, other.openness)
        )
    }
}

/// Each mood's small loop, as a pure function of time so a TimelineView can
/// drive it and it can be tested. The marks are soft, so they move like
/// something soft: they squash before a hop, stretch in the air, squash on
/// landing and wobble back past rest before settling.
///
/// - needs you: two quick hops, then a pause
/// - working: a squishy bob, with a blink
/// - idle: a slow breath with a little jelly in it
/// - error: a decaying shake that wobbles the body
/// - done: one big happy hop with a lean
///
/// Pass `nil` for Reduce Motion (or no mood) and the avatar stays still.
public enum MoodMotion {
    /// How far a full squash (`v = 1`) flattens the body. A stretch is the
    /// same with `v < 0`. Width moves less than height so the body reads as
    /// soft rather than as a rubber sheet.
    static let squashY = 0.20
    static let squashX = 0.16

    /// A per-slug offset in seconds so a roster does not move in lockstep.
    public static func seed(for slug: String) -> Double {
        Double(BlobAvatar.hash(slug) % 1000) / 1000 * 3
    }

    public static func pose(for mood: Mood?, time: Double, seed: Double = 0) -> MoodPose {
        guard let mood else { return .rest }
        let t = time + seed
        switch mood {
        case .needsYou:
            // Two quick hops, the second a little lower, then a rest; every 1.6 s.
            let u = frac(t / 1.6) * 1.6
            let h: (lift: Double, squash: Double)
            if u < 0.42 {
                h = hop(u / 0.42, height: 0.10)
            } else if u >= 0.44 && u < 0.86 {
                h = hop((u - 0.44) / 0.42, height: 0.07)
            } else {
                return .rest
            }
            return squish(h.squash, dy: -h.lift)
        case .working:
            // Sinks and squashes at the bottom of the bob, stretches a touch at the top.
            let s = sin(2 * Double.pi * t / 1.4)
            let v = 0.35 * s * s * (s > 0 ? 1 : -0.6)
            return squish(v, dy: 0.03 * s, openness: blink(t, every: 2.8))
        case .idle:
            // A slow breath (taller on the in-breath) with a faster jelly ripple on top.
            let breath = sin(2 * Double.pi * t / 3.6)
            let ripple = sin(2 * Double.pi * t / 1.2)
            return squish(-0.12 * breath + 0.04 * ripple * (0.5 + 0.5 * breath))
        case .error:
            // A short, decaying shake every 2.4 s; the body jiggles with it.
            let u = frac(t / 2.4) * 2.4
            guard u < 0.6 else { return .rest }
            let decay = (1 - u / 0.6) * (1 - u / 0.6)
            let s = sin(2 * Double.pi * 6 * u) * decay
            let jiggle = 0.35 * sin(2 * Double.pi * 3 * u) * decay
            return squish(jiggle, dx: 0.03 * s, rotation: 6 * s)
        case .done:
            // One big happy hop every 1.8 s, leaning into it while airborne.
            let u = frac(t / 1.8) * 1.8
            guard u < 0.8 else { return .rest }
            let p = u / 0.8
            let h = hop(p, height: 0.17)
            let lean = (p >= 0.18 && p < 0.68) ? -6 * sin(Double.pi * (p - 0.18) / 0.5) : 0
            return squish(h.squash, dy: -h.lift, rotation: lean)
        }
    }

    // MARK: - Tap

    /// How long a tap's squash-and-spring lasts, in seconds.
    public static let tapDuration = 0.75

    /// The pose a tap adds, `elapsed` seconds after the finger lands: a fast
    /// squash (eyes squeezed), then a damped spring back that overshoots
    /// into a stretch and settles. Exactly `.rest` before 0 and from
    /// `tapDuration` on, and continuous in between.
    public static func tap(elapsed t: Double) -> MoodPose {
        guard t > 0, t < tapDuration else { return .rest }
        let attack = 0.09
        var v: Double
        if t < attack {
            v = sin(t / attack * Double.pi / 2)
        } else {
            let u = t - attack
            v = exp(-5.5 * u) * cos(2 * Double.pi * u / 0.34)
        }
        // Taper the last 0.2 s so the spring lands exactly on rest.
        v *= min(1, (tapDuration - t) / 0.2)
        return MoodPose(scaleX: 1 + 0.18 * v, scaleY: 1 - 0.24 * v, openness: 1 - 0.7 * max(0, v))
    }

    // MARK: - Blink

    /// Large avatars blink about once per `blinkPeriod`, at a different
    /// moment each time, now and then twice in a row.
    public static let blinkPeriod = 4.2
    static let blinkLength = 0.16

    /// Eye openness for an occasional, natural-looking blink: 1 almost all
    /// the time, dipping smoothly to 0 and back for `blinkLength`. Pure in
    /// time and seed, so a TimelineView can drive it.
    public static func idleBlink(time: Double, seed: Double = 0) -> Double {
        let t = time + seed
        let cycle = floor(t / blinkPeriod)
        let u = t - cycle * blinkPeriod
        let start = 0.3 + noise(cycle) * (blinkPeriod - 1.0)
        var o = lid(u - start)
        if noise(cycle + 7919) < 0.25 {
            o = min(o, lid(u - start - 0.28))
        }
        return o
    }

    /// One blink's lid: 1 → 0 → 1 over `blinkLength`, 1 outside it.
    static func lid(_ x: Double) -> Double {
        guard x > 0, x < blinkLength else { return 1 }
        return 1 - sin(Double.pi * x / blinkLength)
    }

    /// A deterministic value in [0, 1) for a cycle number.
    static func noise(_ x: Double) -> Double {
        let s = sin(x * 12.9898 + 78.233) * 43758.5453
        let f = s - floor(s)
        return f.isFinite ? min(max(f, 0), 0.999_999) : 0.5
    }

    // MARK: - Building blocks

    /// A pose from a squash amount: `v > 0` is squashed (short and wide),
    /// `v < 0` stretched (tall and thin), 0 is the body at rest.
    static func squish(_ v: Double, dx: Double = 0, dy: Double = 0, rotation: Double = 0, openness: Double = 1) -> MoodPose {
        MoodPose(dx: dx, dy: dy, rotation: rotation, scaleX: 1 + squashX * v, scaleY: 1 - squashY * v, openness: openness)
    }

    /// One cartoon hop over `p` in 0..<1: crouch (squash), take off and fly
    /// (stretched while fast, round at the top), land (squash) and wobble
    /// back through a small stretch to rest. Lift is a fraction of the
    /// avatar's size; squash feeds `squish`. Both are 0 at both ends.
    static func hop(_ p: Double, height: Double) -> (lift: Double, squash: Double) {
        guard p >= 0, p < 1 else { return (0, 0) }
        if p < 0.18 {
            return (0, 0.55 * sin(Double.pi * p / 0.18))
        }
        if p < 0.68 {
            let q = (p - 0.18) / 0.5
            return (height * sin(Double.pi * q), -0.7 * abs(sin(2 * Double.pi * q)))
        }
        let r = (p - 0.68) / 0.32
        return (0, 1.8 * exp(-2.5 * r) * sin(2.5 * Double.pi * r) * (1 - r))
    }

    /// 0 for a 0.14 s blink once per `every` seconds, otherwise 1.
    static func blink(_ t: Double, every period: Double) -> Double {
        frac(t / period) * period < 0.14 ? 0 : 1
    }

    static func frac(_ x: Double) -> Double { x - floor(x) }
}
