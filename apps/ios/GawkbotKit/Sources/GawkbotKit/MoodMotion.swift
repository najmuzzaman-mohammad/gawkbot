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
}

/// Each mood's small loop, as a pure function of time so a TimelineView can
/// drive it and it can be tested: a bounce for needs-you, a gentle bob (and
/// blink) for working, a slow breath for idle, a shake for an error, a hop
/// for done. Pass `nil` for Reduce Motion and the avatar stays still.
public enum MoodMotion {
    /// A per-slug offset in seconds so a roster does not move in lockstep.
    public static func seed(for slug: String) -> Double {
        Double(BlobAvatar.hash(slug) % 1000) / 1000 * 3
    }

    public static func pose(for mood: Mood?, time: Double, seed: Double = 0) -> MoodPose {
        guard let mood else { return .rest }
        let t = time + seed
        switch mood {
        case .needsYou:
            // Two quick bounces, then a rest, every 1.6 s.
            let u = frac(t / 1.6) * 1.6
            guard u < 0.7 else { return .rest }
            let h = abs(sin(u / 0.35 * Double.pi))
            return MoodPose(dy: -0.12 * h, scaleX: 1 - 0.03 * h, scaleY: 1 + 0.04 * h)
        case .working:
            let bob = sin(2 * Double.pi * t / 1.6)
            return MoodPose(dy: 0.035 * bob, openness: blink(t, every: 2.8))
        case .idle:
            let b = sin(2 * Double.pi * t / 4.2)
            return MoodPose(scaleX: 1 + 0.015 * b, scaleY: 1 + 0.025 * b)
        case .error:
            // A short, decaying shake every 2.4 s.
            let u = frac(t / 2.4) * 2.4
            guard u < 0.5 else { return .rest }
            let decay = 1 - u / 0.5
            let s = sin(2 * Double.pi * 7 * u) * decay
            return MoodPose(dx: 0.03 * s, rotation: 7 * s)
        case .done:
            // A happy hop every 1.8 s.
            let u = frac(t / 1.8) * 1.8
            guard u < 0.4 else { return .rest }
            let h = sin(u / 0.4 * Double.pi)
            return MoodPose(dy: -0.18 * h, rotation: -5 * h, scaleX: 1 - 0.04 * h, scaleY: 1 + 0.05 * h)
        }
    }

    /// 0 for a 0.14 s blink once per `every` seconds, otherwise 1.
    static func blink(_ t: Double, every period: Double) -> Double {
        frac(t / period) * period < 0.14 ? 0 : 1
    }

    static func frac(_ x: Double) -> Double { x - floor(x) }
}
