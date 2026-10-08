import Foundation
import XCTest
@testable import GawkbotKit

// MARK: - Chosen avatars: wire shape and resolution

final class BotAvatarTests: XCTestCase {
    // Expected values computed with web/src/lib/blobAvatar.ts:
    //   cd web && bun -e 'import { resolveAvatar } from "./src/lib/blobAvatar";
    //     console.log(resolveAvatar("cos", { shape: "drop" }))'   // …and so on
    // Each valid override field wins; unset or unknown ones fall back to the
    // slug-derived value (blobShapeIndex / blobColor).
    func testResolveMatchesTheWeb() {
        let cases: [(slug: String, avatar: BotAvatar?, shape: Int, color: String)] = [
            ("cos", BotAvatar(shape: "drop"), 2, "#8b6bb1"),
            ("cos", BotAvatar(color: "#FF8800"), 4, "#ff8800"),
            ("cos", nil, 4, "#8b6bb1"),
            ("gtm-lead", BotAvatar(shape: "blob", color: "#3f9c8f"), 7, "#3f9c8f"),
            ("hermes", BotAvatar(shape: "blob"), 7, "#8a7a2e"),
            ("designer", BotAvatar(shape: "star", color: "red"), 4, "#6b7fd7"),
            ("founding-engineer", BotAvatar(), 1, "#4d8bb8"),
            ("pm", nil, 6, "#6f8f43"),
        ]
        for c in cases {
            let look = BlobAvatar.resolve(slug: c.slug, avatar: c.avatar)
            XCTAssertEqual(look.shapeIndex, c.shape, "\(c.slug) \(String(describing: c.avatar))")
            XCTAssertEqual(look.color, c.color, "\(c.slug) \(String(describing: c.avatar))")
        }
    }

    func testOverrideShapeDropIsIndexTwo() {
        XCTAssertEqual(BotAvatar.shapeIndex(named: "drop"), 2)
        XCTAssertEqual(BotAvatar.shapeIndex(named: " Drop "), 2)
        XCTAssertEqual(BlobAvatar.resolve(slug: "cos", avatar: BotAvatar(shape: "drop")).shapeIndex, 2)
    }

    func testOverrideColourWins() {
        let look = BlobAvatar.resolve(slug: "gtm-lead", avatar: BotAvatar(color: "#123ABC"))
        XCTAssertEqual(look.color, "#123abc")
        XCTAssertEqual(look.shapeIndex, BlobAvatar.shapeIndex("gtm-lead"), "an unset shape keeps the derived one")
    }

    func testNoOverrideIsTheDerivedLook() {
        for slug in ["cos", "designer", "gtm-lead", "founding-engineer", "prospect-scout", "pm", "hermes", "ceo"] {
            let look = BlobAvatar.resolve(slug: slug, avatar: nil)
            XCTAssertEqual(look.shapeIndex, BlobAvatar.shapeIndex(slug), slug)
            XCTAssertEqual(look.color, BlobAvatar.colorHex(slug), slug)
            let empty = BlobAvatar.resolve(slug: slug, avatar: BotAvatar())
            XCTAssertEqual(empty.shapeIndex, look.shapeIndex, slug)
            XCTAssertEqual(empty.color, look.color, slug)
        }
    }

    func testShapeIDsAreTheSilhouetteTable() {
        XCTAssertEqual(BotAvatar.shapeIDs, ["block", "dome", "drop", "bean", "pill", "loaf", "shield", "blob"])
        XCTAssertEqual(BotAvatar.shapeIDs.count, BlobAvatar.silhouettes.count)
        XCTAssertEqual(BotAvatar.shapeID(at: 9), "dome", "wraps")
        XCTAssertEqual(BotAvatar.shapeID(at: -1), "blob", "wraps negatives")
    }

    func testColourValidation() {
        XCTAssertEqual(BotAvatar.normalizedColor("#A1b2C3"), "#a1b2c3")
        XCTAssertEqual(BotAvatar.normalizedColor("  #a1b2c3 "), "#a1b2c3")
        XCTAssertNil(BotAvatar.normalizedColor("#abc"))
        XCTAssertNil(BotAvatar.normalizedColor("a1b2c3"))
        XCTAssertNil(BotAvatar.normalizedColor("#a1b2c3ff"))
        XCTAssertNil(BotAvatar.normalizedColor("#g1b2c3"))
        XCTAssertNil(BotAvatar.normalizedColor("red"))
        XCTAssertNil(BotAvatar.normalizedColor(""))
        XCTAssertNil(BotAvatar.normalizedColor(nil))
    }

    func testHexFromComponents() {
        XCTAssertEqual(BotAvatar.hex(red: 1, green: 0.5, blue: 0), "#ff8000")
        XCTAssertEqual(BotAvatar.hex(red: 0, green: 0, blue: 0), "#000000")
        XCTAssertEqual(BotAvatar.hex(red: 2, green: -1, blue: .nan), "#ff0000", "clamps wide-gamut and junk")
        XCTAssertEqual(BotAvatar.hex(red: 0x6b / 255.0, green: 0x7f / 255.0, blue: 0xd7 / 255.0), "#6b7fd7", "round-trips the palette")
        for hex in BlobAvatar.colors {
            XCTAssertNotNil(BotAvatar.normalizedColor(hex), hex)
        }
    }

    func testWireBodyOnlySendsValidFields() {
        XCTAssertEqual(BotAvatar().wireBody, [:])
        XCTAssertEqual(BotAvatar(shape: " Drop ", color: "#AABBCC").wireBody, ["shape": "drop", "color": "#aabbcc"])
        XCTAssertEqual(BotAvatar(shape: "star", color: "#aabbcc").wireBody, ["color": "#aabbcc"])
        XCTAssertEqual(BotAvatar(shape: "pill", color: "blue").wireBody, ["shape": "pill"])
        XCTAssertTrue(BotAvatar(shape: "star", color: "blue").isAutomatic)
        XCTAssertFalse(BotAvatar(shape: "pill").isAutomatic)
    }

    func testMembersDecodeTheAvatar() throws {
        let json = #"""
        {"members":[
          {"slug":"cos","name":"Chief of Staff","built_in":true,"avatar":{"shape":"drop","color":"#3f9c8f"}},
          {"slug":"pm","name":"PM","avatar":{"color":"#a8546b"}},
          {"slug":"gtm-lead","name":"GTM Lead"},
          {"slug":"odd","name":"Odd","avatar":"not an object"},
          {"slug":"odd2","name":"Odd 2","avatar":{"shape":3,"color":"#a8546b"}}
        ]}
        """#
        struct Envelope: Decodable { let members: [Bot] }
        let bots = try JSONDecoder().decode(Envelope.self, from: Data(json.utf8)).members
        XCTAssertEqual(bots.count, 5, "a malformed avatar never drops a member")
        XCTAssertEqual(bots[0].avatar, BotAvatar(shape: "drop", color: "#3f9c8f"))
        XCTAssertEqual(bots[0].builtIn, true)
        XCTAssertNil(bots[1].avatar?.shape)
        XCTAssertEqual(bots[1].avatar?.colorHex, "#a8546b")
        XCTAssertNil(bots[2].avatar)
        XCTAssertNil(bots[3].avatar)
        XCTAssertEqual(bots[4].avatar, BotAvatar(shape: nil, color: "#a8546b"), "a mistyped field reads as unset")
    }

    func testNotchAgentsDecodeTheAvatar() throws {
        let json = #"{"mood":"idle","headline":"","agents":[{"slug":"cos","name":"CoS","mood":"idle","avatar":{"shape":"drop"}},{"slug":"pm","name":"PM","mood":"working"}]}"#
        let state = try JSONDecoder().decode(NotchState.self, from: Data(json.utf8))
        XCTAssertEqual(state.agents[0].avatar, BotAvatar(shape: "drop"))
        XCTAssertNil(state.agents[1].avatar)
        let look = BlobAvatar.resolve(slug: "cos", avatar: state.agents[0].avatar)
        XCTAssertEqual(look.shapeIndex, 2)
        XCTAssertEqual(look.color, "#8b6bb1")
    }

    func testEncodingOmitsUnsetFields() throws {
        let data = try JSONEncoder().encode(BotAvatar(shape: "pill"))
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(object?["shape"] as? String, "pill")
        XCTAssertNil(object?["color"])
    }

    func testDerivedInboxCarriesTheAvatar() {
        let bots = [Bot(slug: "cos", name: "Chief of Staff", builtIn: true, avatar: BotAvatar(shape: "loaf"))]
        let state = NotchState.derived(bots: bots, requests: [], working: [])
        XCTAssertEqual(state.agent("cos")?.avatar, BotAvatar(shape: "loaf"))
    }

    func testSmoothMarkWearsTheAvatar() {
        XCTAssertEqual(SmoothBlob.mark("cos", avatar: nil), SmoothBlob.mark("cos"), "no override is today's mark")
        let dressed = SmoothBlob.mark("cos", avatar: BotAvatar(shape: "drop", color: "#3F9C8F"))
        XCTAssertEqual(dressed.colorHex, "#3f9c8f")
        // gtm-lead's derived shape is the drop, so its body is the same curve.
        let drop = SmoothBlob.mark("gtm-lead")
        XCTAssertEqual(dressed.start, drop.start)
        XCTAssertEqual(dressed.segments, drop.segments)
        XCTAssertEqual(dressed.eyes, drop.eyes)
        XCTAssertEqual(SmoothBlob.mark(shapeIndex: 10, colorHex: "#000000").segments, SmoothBlob.mark(shapeIndex: 2, colorHex: "#000000").segments, "wraps")
    }
}

// MARK: - Mock office: picking a look

final class MockAvatarTests: XCTestCase {
    func testUpdateShowsInMembersAndNotchThenResets() async throws {
        let broker = MockBroker(config: .init(typingDelay: .milliseconds(5), replyDelay: .milliseconds(5)))
        let seeded = try await broker.members().first { $0.slug == "hermes" }
        XCTAssertEqual(seeded?.avatar, BotAvatar(shape: "blob"), "mock seeds one partial override")

        try await broker.updateAvatar(slug: "cos", avatar: BotAvatar(shape: "Drop", color: "#AABBCC"))
        let cos = try await broker.members().first { $0.slug == "cos" }
        XCTAssertEqual(cos?.avatar, BotAvatar(shape: "drop", color: "#aabbcc"), "normalised like the broker")
        let agent = try await broker.notchState().agent("cos")
        XCTAssertEqual(agent?.avatar, BotAvatar(shape: "drop", color: "#aabbcc"))

        try await broker.updateAvatar(slug: "cos", avatar: nil)
        let reset = try await broker.members().first { $0.slug == "cos" }
        XCTAssertNil(reset?.avatar)
        try await broker.updateAvatar(slug: "hermes", avatar: BotAvatar())
        let hermes = try await broker.notchState().agent("hermes")
        XCTAssertNil(hermes?.avatar, "{} resets")
    }

    func testUpdateRejectsWhatTheBrokerRejects() async throws {
        let broker = MockBroker()
        do {
            try await broker.updateAvatar(slug: "cos", avatar: BotAvatar(shape: "star"))
            XCTFail("unknown shape should be refused")
        } catch let e as BrokerError {
            guard case .http(400, _) = e else { return XCTFail("wrong error \(e)") }
        }
        do {
            try await broker.updateAvatar(slug: "cos", avatar: BotAvatar(color: "#abc"))
            XCTFail("short colour should be refused")
        } catch let e as BrokerError {
            XCTAssertEqual(e, .http(400, "avatar color must be a #rrggbb hex colour"))
        }
        do {
            try await broker.updateAvatar(slug: "nobody", avatar: BotAvatar(shape: "pill"))
            XCTFail("unknown member should be refused")
        } catch let e as BrokerError {
            XCTAssertEqual(e, .http(404, "member not found"))
        }
        let cos = try await broker.members().first { $0.slug == "cos" }
        XCTAssertNil(cos?.avatar, "a refused update changes nothing")
    }
}

// MARK: - BrokerClient: POST /office-members update

final class BrokerClientAvatarTests: XCTestCase {
    private func makeClient() -> BrokerClient {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [StubURLProtocol.self]
        return BrokerClient(baseURL: URL(string: "http://100.64.0.5:7890")!, token: "tok", session: URLSession(configuration: cfg))
    }

    private static func body(_ req: URLRequest) -> [String: Any] {
        var data = req.httpBody ?? Data()
        if data.isEmpty, let stream = req.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let n = stream.read(&buffer, maxLength: buffer.count)
                if n <= 0 { break }
                data.append(buffer, count: n)
            }
        }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }

    func testUpdatePostsTheAvatar() async throws {
        StubURLProtocol.handler = { req in
            XCTAssertEqual(req.httpMethod, "POST")
            XCTAssertEqual(req.url?.path, "/office-members")
            XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
            let body = Self.body(req)
            XCTAssertEqual(body["action"] as? String, "update")
            XCTAssertEqual(body["slug"] as? String, "cos")
            XCTAssertEqual(body["avatar"] as? [String: String], ["shape": "drop", "color": "#3f9c8f"])
            return (200, Data(#"{"member":{"slug":"cos","name":"Chief of Staff","avatar":{"shape":"drop","color":"#3f9c8f"}}}"#.utf8))
        }
        try await makeClient().updateAvatar(slug: "cos", avatar: BotAvatar(shape: "drop", color: "#3F9C8F"))
    }

    func testResetSendsAnEmptyObject() async throws {
        StubURLProtocol.handler = { req in
            let body = Self.body(req)
            XCTAssertEqual(body["avatar"] as? [String: String], [:], "avatar: {} resets")
            XCTAssertNotNil(body["avatar"], "avatar must be present: omitting it leaves the look alone")
            return (200, Data())
        }
        try await makeClient().updateAvatar(slug: "cos", avatar: nil)
    }

    func testRefusalIsTyped() async {
        StubURLProtocol.handler = { _ in (400, Data("avatar shape must be one of block, dome\n".utf8)) }
        do {
            try await makeClient().updateAvatar(slug: "cos", avatar: BotAvatar(shape: "pill"))
            XCTFail("expected an error")
        } catch let e as BrokerError {
            XCTAssertEqual(e, .http(400, "avatar shape must be one of block, dome"))
        } catch {
            XCTFail("wrong error \(error)")
        }
    }
}

// MARK: - Squishy motion envelopes

final class SquishMotionTests: XCTestCase {
    private func distanceFromRest(_ p: MoodPose) -> Double {
        max(abs(p.dx), abs(p.dy), abs(p.rotation) / 100, abs(p.scaleX - 1), abs(p.scaleY - 1))
    }

    func testTapSquashesThenSpringsBackToRest() {
        XCTAssertEqual(MoodMotion.tap(elapsed: -0.1), .rest)
        XCTAssertEqual(MoodMotion.tap(elapsed: 0), .rest)
        XCTAssertEqual(MoodMotion.tap(elapsed: MoodMotion.tapDuration), .rest)
        XCTAssertEqual(MoodMotion.tap(elapsed: 5), .rest)

        let peak = MoodMotion.tap(elapsed: 0.09)
        XCTAssertLessThan(peak.scaleY, 0.8, "squashes flat")
        XCTAssertGreaterThan(peak.scaleX, 1.12, "and wide")
        XCTAssertLessThan(peak.openness, 0.5, "eyes squeezed")

        var overshoot = false
        var previous = MoodPose.rest
        for i in 0...Int(MoodMotion.tapDuration * 1000) {
            let p = MoodMotion.tap(elapsed: Double(i) / 1000)
            XCTAssertGreaterThanOrEqual(p.scaleY, 0.74)
            XCTAssertLessThanOrEqual(p.scaleY, 1.12)
            XCTAssertGreaterThanOrEqual(p.scaleX, 0.9)
            XCTAssertLessThanOrEqual(p.scaleX, 1.2)
            XCTAssertTrue((0...1).contains(p.openness))
            XCTAssertEqual(p.dx, 0)
            XCTAssertEqual(p.dy, 0)
            if p.scaleY > 1.03 { overshoot = true }
            // Continuous: no jump bigger than a hair per millisecond.
            XCTAssertLessThan(abs(p.scaleY - previous.scaleY), 0.01, "t=\(i)ms")
            previous = p
        }
        XCTAssertTrue(overshoot, "springs past rest into a stretch")
        XCTAssertLessThan(distanceFromRest(MoodMotion.tap(elapsed: MoodMotion.tapDuration - 0.001)), 0.001, "lands on rest")
    }

    func testEveryMoodSquashesAndStretchesWithinBounds() {
        for mood in Mood.allCases {
            var minY = 1.0, maxY = 1.0
            for t in stride(from: 0.0, to: 8.0, by: 0.005) {
                let p = MoodMotion.pose(for: mood, time: t)
                XCTAssertLessThanOrEqual(abs(p.dx), 0.05, "\(mood)")
                XCTAssertLessThanOrEqual(abs(p.dy), 0.2, "\(mood)")
                XCTAssertLessThanOrEqual(abs(p.rotation), 8, "\(mood)")
                XCTAssertEqual(p.scaleX, 1, accuracy: 0.2, "\(mood)")
                XCTAssertEqual(p.scaleY, 1, accuracy: 0.25, "\(mood)")
                XCTAssertTrue((0...1).contains(p.openness), "\(mood)")
                minY = min(minY, p.scaleY)
                maxY = max(maxY, p.scaleY)
            }
            XCTAssertLessThan(minY, 0.99, "\(mood) squashes")
            XCTAssertGreaterThan(maxY, 1.01, "\(mood) stretches")
        }
    }

    func testHopsReadAsCartoonHops() {
        for mood in [Mood.needsYou, .done] {
            var minY = 1.0, maxY = 1.0
            for t in stride(from: 0.0, to: 2.0, by: 0.002) {
                let p = MoodMotion.pose(for: mood, time: t)
                minY = min(minY, p.scaleY)
                maxY = max(maxY, p.scaleY)
            }
            XCTAssertLessThan(minY, 0.88, "\(mood) squashes hard on landing")
            XCTAssertGreaterThan(maxY, 1.08, "\(mood) stretches in the air")
        }
    }

    func testEveryLoopReturnsToRest() {
        for mood in Mood.allCases {
            var closest = Double.infinity
            for t in stride(from: 0.0, to: 4.5, by: 0.005) {
                closest = min(closest, distanceFromRest(MoodMotion.pose(for: mood, time: t)))
            }
            XCTAssertLessThan(closest, 0.005, "\(mood) comes back to rest each loop")
        }
        // The loops with a pause sit exactly at rest during it.
        XCTAssertEqual(MoodMotion.pose(for: .needsYou, time: 1.2), .rest)
        XCTAssertEqual(MoodMotion.pose(for: .error, time: 1.0), .rest)
        XCTAssertEqual(MoodMotion.pose(for: .done, time: 1.0), .rest)
    }

    func testHopIsZeroAtBothEnds() {
        for height in [0.07, 0.1, 0.17] {
            let start = MoodMotion.hop(0, height: height)
            XCTAssertEqual(start.lift, 0)
            XCTAssertEqual(start.squash, 0, accuracy: 1e-12)
            let end = MoodMotion.hop(0.999_999, height: height)
            XCTAssertEqual(end.lift, 0)
            XCTAssertEqual(end.squash, 0, accuracy: 1e-4)
            XCTAssertEqual(MoodMotion.hop(1, height: height).squash, 0)
            for p in stride(from: 0.0, to: 1.0, by: 0.001) {
                let h = MoodMotion.hop(p, height: height)
                XCTAssertTrue((0...height).contains(h.lift))
                XCTAssertLessThanOrEqual(abs(h.squash), 1)
            }
        }
    }

    func testIdleBlinkIsOccasionalAndBounded() {
        for base in [0.0, 781_000_000.0, 812_345_678.9] {
            var closings = 0
            var open = 0
            var previous = 1.0
            var perWindow: [Int] = []
            var inWindow = 0
            let steps = 6000
            for i in 0..<steps {
                let o = MoodMotion.idleBlink(time: base + Double(i) * 0.01, seed: 1.3)
                XCTAssertTrue((0...1).contains(o))
                if o == 1 { open += 1 }
                if o < 0.5 && previous >= 0.5 { closings += 1; inWindow += 1 }
                previous = o
                if (i + 1) % 1000 == 0 { perWindow.append(inWindow); inWindow = 0 }
            }
            XCTAssertGreaterThan(Double(open) / Double(steps), 0.9, "eyes open nearly all the time")
            for count in perWindow {
                XCTAssertTrue((1...8).contains(count), "every 10 s blinks a few times, got \(count)")
            }
            XCTAssertGreaterThan(closings, 8)
        }
        XCTAssertEqual(MoodMotion.idleBlink(time: 42, seed: 0.5), MoodMotion.idleBlink(time: 42, seed: 0.5), "deterministic")
    }

    func testPosesCombine() {
        let a = MoodPose(dx: 0.01, dy: -0.02, rotation: 3, scaleX: 1.1, scaleY: 0.9, openness: 0.8)
        XCTAssertEqual(MoodPose.rest.combined(with: a), a)
        XCTAssertEqual(a.combined(with: .rest), a)
        let b = a.combined(with: MoodPose(dx: 0.01, scaleY: 0.5, openness: 0.2))
        XCTAssertEqual(b.dx, 0.02, accuracy: 1e-12)
        XCTAssertEqual(b.scaleY, 0.45, accuracy: 1e-12)
        XCTAssertEqual(b.openness, 0.2)
    }
}
