import Foundation
import XCTest
@testable import GawkbotKit

// MARK: - Chosen avatars: wire shape and resolution

final class BotAvatarTests: XCTestCase {
    // Expected values computed with web/src/lib/blobAvatar.ts:
    //   cd web && bun -e 'import { resolveAvatar } from "./src/lib/blobAvatar";
    //     console.log(resolveAvatar("cos", { shape: "ghost" }))'   // …and so on
    // Each valid override field wins; unset or unknown ones fall back to the
    // slug-derived value (blobShapeIndex / blobColor).
    func testResolveMatchesTheWeb() {
        let cases: [(slug: String, avatar: BotAvatar?, shape: Int, color: String)] = [
            ("cos", BotAvatar(shape: "ghost"), 2, "#5aa9ff"),
            ("cos", BotAvatar(color: "#FF8800"), 4, "#ff8800"),
            ("cos", nil, 4, "#5aa9ff"),
            ("gtm-lead", BotAvatar(shape: "flower", color: "#3f9c8f"), 7, "#3f9c8f"),
            ("hermes", BotAvatar(shape: "blob"), 7, "#ff7a59"),
            ("designer", BotAvatar(shape: "star", color: "red"), 4, "#ffa53d"),
            ("founding-engineer", BotAvatar(), 1, "#b48cff"),
            ("pm", nil, 6, "#3cc3df"),
        ]
        for c in cases {
            let look = BlobAvatar.resolve(slug: c.slug, avatar: c.avatar)
            XCTAssertEqual(look.shapeIndex, c.shape, "\(c.slug) \(String(describing: c.avatar))")
            XCTAssertEqual(look.color, c.color, "\(c.slug) \(String(describing: c.avatar))")
        }
    }

    func testOverrideShapeGhostIsIndexTwo() {
        XCTAssertEqual(BotAvatar.shapeIndex(named: "ghost"), 2)
        XCTAssertEqual(BotAvatar.shapeIndex(named: " Ghost "), 2)
        XCTAssertEqual(BlobAvatar.resolve(slug: "cos", avatar: BotAvatar(shape: "ghost")).shapeIndex, 2)
        XCTAssertEqual(BotAvatar.shapeIndex(named: "drop"), 4)
    }

    /// Shape ids stored by an office from before the orbs still resolve, to
    /// the orb each maps to, and are written back as the current id.
    func testLegacyShapeIDsResolve() {
        let legacy: [(old: String, new: String)] = [
            ("block", "stack"), ("dome", "bear"), ("drop", "drop"), ("bean", "seacow"),
            ("pill", "lemon"), ("loaf", "cloud"), ("shield", "ghost"), ("blob", "flower"),
        ]
        XCTAssertEqual(BotAvatar.legacyShapeIDs.count, legacy.count)
        for c in legacy {
            XCTAssertEqual(BotAvatar.legacyShapeIDs[c.old], c.new, c.old)
            XCTAssertTrue(BotAvatar.shapeIDs.contains(c.new), c.new)
            XCTAssertEqual(BotAvatar.shapeIndex(named: c.old), BotAvatar.shapeIDs.firstIndex(of: c.new), c.old)
            XCTAssertEqual(BotAvatar.shapeIndex(named: " \(c.old.capitalized) "), BotAvatar.shapeIndex(named: c.new), c.old)
            XCTAssertEqual(BotAvatar(shape: c.old).wireBody, ["shape": c.new], "writes the current id back")
            XCTAssertEqual(OrbAvatar.mark(slug: "cos", avatar: BotAvatar(shape: c.old)).shape, c.new, c.old)
        }
        XCTAssertEqual(BotAvatar.shapeIndex(named: "block"), 5)
        XCTAssertEqual(BotAvatar.shapeIndex(named: "dome"), 0)
        XCTAssertFalse(BotAvatar(shape: "loaf").isAutomatic)
        XCTAssertNil(BotAvatar.shapeIndex(named: "star"), "unknown ids stay unknown")
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

    func testShapeIDsAreTheOrbBodies() {
        XCTAssertEqual(BotAvatar.shapeIDs, ["bear", "lemon", "ghost", "cloud", "drop", "stack", "seacow", "flower"])
        XCTAssertEqual(BotAvatar.shapeIDs, OrbAvatar.Body.allCases.map(\.rawValue), "index-aligned with the bodies")
        XCTAssertEqual(BotAvatar.shapeIDs.count, BlobAvatar.shapeCount)
        XCTAssertEqual(BotAvatar.shapeID(at: 9), "lemon", "wraps")
        XCTAssertEqual(BotAvatar.shapeID(at: -1), "flower", "wraps negatives")
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
        XCTAssertEqual(BotAvatar(shape: "lemon", color: "blue").wireBody, ["shape": "lemon"])
        XCTAssertEqual(BotAvatar(shape: "pill", color: "blue").wireBody, ["shape": "lemon"], "a legacy id goes out as the current one")
        XCTAssertTrue(BotAvatar(shape: "star", color: "blue").isAutomatic)
        XCTAssertFalse(BotAvatar(shape: "lemon").isAutomatic)
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
        XCTAssertEqual(look.shapeIndex, 4)
        XCTAssertEqual(look.color, "#5aa9ff")
    }

    func testEncodingOmitsUnsetFields() throws {
        let data = try JSONEncoder().encode(BotAvatar(shape: "lemon"))
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(object?["shape"] as? String, "lemon")
        XCTAssertNil(object?["color"])
    }

    func testDerivedInboxCarriesTheAvatar() {
        let bots = [Bot(slug: "cos", name: "Chief of Staff", builtIn: true, avatar: BotAvatar(shape: "cloud"))]
        let state = NotchState.derived(bots: bots, requests: [], working: [])
        XCTAssertEqual(state.agent("cos")?.avatar, BotAvatar(shape: "cloud"))
    }

    func testMarkWearsTheAvatar() {
        XCTAssertEqual(OrbAvatar.mark(slug: "cos", avatar: nil), OrbAvatar.mark(slug: "cos"), "no override is today's mark")
        let dressed = OrbAvatar.mark(slug: "cos", avatar: BotAvatar(shape: "drop", color: "#3F9C8F"))
        XCTAssertEqual(dressed.color, "#3f9c8f")
        XCTAssertEqual(dressed.shape, "drop")
        XCTAssertEqual(dressed.body, .drop)
        // cos's derived shape is the drop too (index 4), so the pieces and the
        // eyes are the same; only the colour and its tints differ.
        let derived = OrbAvatar.mark(slug: "cos")
        XCTAssertEqual(derived.body, .drop)
        XCTAssertEqual(dressed.pieces, derived.pieces)
        XCTAssertEqual(dressed.eyes, derived.eyes)
        XCTAssertEqual(dressed.mouth, derived.mouth)
        XCTAssertNotEqual(dressed.shade, derived.shade)
        XCTAssertEqual(OrbAvatar.mark(shapeIndex: 10, colorHex: "#000000").pieces, OrbAvatar.mark(shapeIndex: 2, colorHex: "#000000").pieces, "wraps")
        XCTAssertEqual(OrbAvatar.mark(shapeIndex: -1, colorHex: "#000000").body, .flower, "wraps negatives")
    }
}

// MARK: - Orb geometry and colour (ported from orb-mascot core.js)

final class OrbAvatarTests: XCTestCase {
    private let d2r = Double.pi / 180

    /// core.js `extentOf` / `fitOf` worked by hand from the COMPOSED table.
    func testFitsMatchCoreJS() {
        // bear: main circle 0.05 + 0.9 = 0.95, ears 0.62 + 0.32 = 0.94.
        XCTAssertEqual(OrbAvatar.Body.bear.extent, 0.95, accuracy: 1e-12)
        XCTAssertEqual(OrbAvatar.Body.bear.fit, 1, accuracy: 1e-12)
        // lemon: nubs 0.72 + 0.3; ghost: the middle tail bump 0.7 + 0.3.
        XCTAssertEqual(OrbAvatar.Body.lemon.fit, 0.95 / 1.02, accuracy: 1e-12)
        XCTAssertEqual(OrbAvatar.Body.ghost.fit, 0.95, accuracy: 1e-12)
        // drop: 0.12 + 0.84 and 0.7 + 0.26 both 0.96; stack: ellipse 0.36 + 0.52;
        // seacow: feet 0.62 + 0.32.
        XCTAssertEqual(OrbAvatar.Body.drop.fit, 0.95 / 0.96, accuracy: 1e-12)
        XCTAssertEqual(OrbAvatar.Body.stack.fit, 0.95 / 0.88, accuracy: 1e-12)
        XCTAssertEqual(OrbAvatar.Body.seacow.fit, 0.95 / 0.94, accuracy: 1e-12)
        // cloud: a 0.94 × 0.5 pill at 45° reaches hypot(0.94, 0.5) / √2 on
        // each axis, and the cloud fits to 0.86 rather than 0.95.
        XCTAssertEqual(OrbAvatar.Body.cloud.fitTarget, 0.86)
        XCTAssertEqual(OrbAvatar.Body.cloud.fit, 0.86 / (hypot(0.94, 0.5) / 2.0.squareRoot()), accuracy: 1e-9)
        // flower: the petals at 22.5° reach 0.62·cos 22.5° + 0.33.
        XCTAssertEqual(OrbAvatar.Body.flower.fit, 0.95 / (0.62 * cos(.pi / 8) + 0.33), accuracy: 1e-9)
        XCTAssertEqual(OrbAvatar.Body.flower.pieces.count, 9)
    }

    func testEveryBodyFitsItsTarget() {
        for body in OrbAvatar.Body.allCases {
            let m = OrbAvatar.mark(body: body, colorHex: "#5aa9ff")
            XCTAssertEqual(m.body, body)
            XCTAssertEqual(m.shape, body.rawValue)
            XCTAssertEqual(m.pieces.count, body.pieces.count, body.rawValue)
            // Back to units of the radius about the centre, the fitted
            // silhouette reaches exactly the target.
            let reach = m.pieces.map { p in
                OrbAvatar.Piece(
                    x: (p.x - OrbAvatar.center) / OrbAvatar.radius, y: (p.y - OrbAvatar.center) / OrbAvatar.radius,
                    rx: p.rx / OrbAvatar.radius, ry: p.ry / OrbAvatar.radius, angle: p.angle
                ).extent
            }.max() ?? 0
            XCTAssertEqual(reach, body.fitTarget, accuracy: 1e-9, body.rawValue)
            XCTAssertEqual(m.eyes.count, 2, body.rawValue)
            XCTAssertLessThan(m.eyes[0].center.x, m.eyes[1].center.x, "left eye first")
            XCTAssertEqual(m.eyes[0].center.y, m.eyes[1].center.y, accuracy: 1e-9, body.rawValue)
            XCTAssertEqual(m.mouth.transform.tx, OrbAvatar.center, accuracy: 1e-9, "the mouth is centred")
            XCTAssertGreaterThan(m.mouth.transform.ty, m.eyes[0].center.y, "and below the eyes")
            XCTAssertEqual(m.shade.radius, 1.35 * OrbAvatar.radius, accuracy: 1e-9)
        }
        // Only the cloud and the stack have ellipses.
        XCTAssertFalse(OrbAvatar.mark(body: .cloud, colorHex: "#5aa9ff").pieces[0].isCircle)
        XCTAssertEqual(OrbAvatar.mark(body: .cloud, colorHex: "#5aa9ff").pieces[0].angle, -45)
        XCTAssertFalse(OrbAvatar.mark(body: .stack, colorHex: "#5aa9ff").pieces[1].isCircle)
        XCTAssertTrue(OrbAvatar.mark(body: .stack, colorHex: "#5aa9ff").pieces[0].isCircle)
    }

    /// The bear at rest, by hand from core.js: fit 1, surf {cx 0, cy 0.05, rx 0.88, ry 0.88}.
    func testBearGeometryMatchesCoreJS() {
        let r = OrbAvatar.radius
        let m = OrbAvatar.mark(body: .bear, colorHex: "#0a0a0a")
        XCTAssertEqual(m.pieces.count, 3)
        XCTAssertEqual(m.pieces[0].x, 100, accuracy: 1e-9)
        XCTAssertEqual(m.pieces[0].y, 100 + 0.05 * r, accuracy: 1e-9)
        XCTAssertEqual(m.pieces[0].rx, 0.9 * r, accuracy: 1e-9)
        XCTAssertTrue(m.pieces[0].isCircle)
        XCTAssertEqual(m.pieces[1].x, 100 - 0.6 * r, accuracy: 1e-9)
        XCTAssertEqual(m.pieces[1].y, 100 - 0.62 * r, accuracy: 1e-9)
        XCTAssertEqual(m.pieces[2].rx, 0.32 * r, accuracy: 1e-9)

        // Eyes: x = 100 + R·rx·sin 16°·cos 4°, y = 100 + R·(cy − ry·sin 4°).
        let ex = r * 0.88 * sin(16 * d2r) * cos(4 * d2r)
        let ey = 100 + r * (0.05 - 0.88 * sin(4 * d2r))
        XCTAssertEqual(m.eyes[0].center.x, 100 - ex, accuracy: 1e-9)
        XCTAssertEqual(m.eyes[1].center.x, 100 + ex, accuracy: 1e-9)
        XCTAssertEqual(m.eyes[0].center.y, ey, accuracy: 1e-9)
        XCTAssertEqual(m.eyes[1].center.y, ey, accuracy: 1e-9)
        XCTAssertEqual(m.eyes[0].center.x, 76.7709, accuracy: 1e-3)
        XCTAssertEqual(m.eyes[0].center.y, 98.907, accuracy: 1e-3)
        // A 22-unit disc, fully rounded.
        XCTAssertEqual(m.eyes[0].rx, 11, accuracy: 1e-12)
        XCTAssertEqual(m.eyes[0].ry, 11, accuracy: 1e-12)
        // The tangent frame (kx = ky = 1): a = cos lon, b = 0, c = −sin lon·sin lat, d = cos lat.
        let left = m.eyes[0].transform
        XCTAssertEqual(left.a, cos(16 * d2r), accuracy: 1e-9)
        XCTAssertEqual(left.b, 0, accuracy: 1e-12)
        XCTAssertEqual(left.c, -sin(16 * d2r) * sin(4 * d2r), accuracy: 1e-9)
        XCTAssertEqual(left.d, cos(4 * d2r), accuracy: 1e-9)
        XCTAssertEqual(m.eyes[1].transform.c, sin(16 * d2r) * sin(4 * d2r), accuracy: 1e-9)

        // Mouth: the frame at (0, 4° − 22°), hw 14, bulge 0.4·14·1.15, stroke 6·1.3.
        XCTAssertEqual(m.mouth.transform.tx, 100, accuracy: 1e-9)
        XCTAssertEqual(m.mouth.transform.ty, 100 + r * (0.05 + 0.88 * sin(18 * d2r)), accuracy: 1e-9)
        XCTAssertEqual(m.mouth.transform.ty, 130.9058, accuracy: 1e-3)
        XCTAssertEqual(m.mouth.transform.a, 1, accuracy: 1e-12)
        XCTAssertEqual(m.mouth.transform.d, cos(18 * d2r), accuracy: 1e-9)
        XCTAssertEqual(m.mouth.halfWidth, 14, accuracy: 1e-12)
        XCTAssertEqual(m.mouth.bulge, 0.4 * 14 * 1.15, accuracy: 1e-12)
        XCTAssertEqual(m.mouth.strokeWidth, 7.8, accuracy: 1e-12)
        XCTAssertEqual(m.mouth.start.x, 86, accuracy: 1e-9)
        XCTAssertEqual(m.mouth.end.x, 114, accuracy: 1e-9)
        XCTAssertEqual(m.mouth.control.y, m.mouth.transform.ty + 0.4 * 14 * 1.15 * cos(18 * d2r), accuracy: 1e-9)

        // Shade: the frame at (0, 28°) less (0.12R, 0.1R), radius 1.35R.
        XCTAssertEqual(m.shade.center.x, 100 - 0.12 * r, accuracy: 1e-9)
        XCTAssertEqual(m.shade.center.y, 100 + r * (0.05 - 0.88 * sin(28 * d2r)) - 0.1 * r, accuracy: 1e-9)
        XCTAssertEqual(m.shade.center.y, 55.539, accuracy: 1e-3)
        XCTAssertEqual(m.shade.radius, 1.35 * r, accuracy: 1e-9)
    }

    /// The lemon's spheroid (rx 0.84, ry 0.98) stretches the frame: kx = rx / avg, ky = ry / avg.
    func testSpheroidScalesTheFrame() {
        let fit = OrbAvatar.Body.lemon.fit
        let avg = (0.84 + 0.98) / 2
        let m = OrbAvatar.mark(body: .lemon, colorHex: "#0a0a0a")
        XCTAssertEqual(m.eyes[1].transform.a, cos(16 * d2r) * 0.84 / avg, accuracy: 1e-9)
        XCTAssertEqual(m.eyes[1].transform.d, cos(4 * d2r) * 0.98 / avg, accuracy: 1e-9)
        XCTAssertEqual(m.eyes[1].center.x, 100 + OrbAvatar.radius * 0.84 * fit * sin(16 * d2r) * cos(4 * d2r), accuracy: 1e-9)
        XCTAssertEqual(m.eyes[1].center.y, 100 - OrbAvatar.radius * 0.98 * fit * sin(4 * d2r), accuracy: 1e-9)
    }

    func testStillsShapeTheFace() {
        func mark(_ face: OrbAvatar.Face) -> OrbAvatar.Mark { OrbAvatar.mark(body: .bear, colorHex: "#0a0a0a", face: face) }
        let calm = mark(.calm)
        XCTAssertEqual(calm, OrbAvatar.mark(body: .bear, colorHex: "#0a0a0a"), "calm is the default")

        let working = mark(.working)
        XCTAssertEqual(working.eyes[0].rx, 11, accuracy: 1e-12, "squash narrows the height only")
        XCTAssertEqual(working.eyes[0].ry, 11 * 0.7, accuracy: 1e-12)
        XCTAssertEqual(working.mouth.bulge, 0.15 * 14 * 1.15, accuracy: 1e-12)
        XCTAssertEqual(working.pieces, calm.pieces, "the face never moves the body")

        let asking = mark(.asking)
        XCTAssertEqual(asking.eyes[0].rx, 11 * 1.15, accuracy: 1e-12)
        XCTAssertEqual(asking.eyes[0].ry, 11 * 1.15, accuracy: 1e-12)
        XCTAssertEqual(asking.mouth.halfWidth, 14 * 1.15 * 0.6, accuracy: 1e-12)
        XCTAssertEqual(asking.mouth.strokeWidth, 7.8 * 1.15, accuracy: 1e-12)
        XCTAssertEqual(asking.mouth.bulge, 0.1 * (14 * 1.15 * 0.6) * 1.15, accuracy: 1e-12)

        XCTAssertLessThan(mark(.oops).mouth.bulge, 0, "a frown bulges up")
        XCTAssertGreaterThan(mark(.happy).mouth.bulge, calm.mouth.bulge, "a grin bulges further down")
        XCTAssertLessThan(mark(.sleepy).eyes[0].ry, working.eyes[0].ry)

        // A blink: height × (1 − 0.94), and a shift of 0.08·h down the frame.
        var shut = OrbAvatar.Face.calm
        shut.blink = 1
        let blinked = mark(shut)
        XCTAssertEqual(blinked.eyes[0].ry, 11 * 0.06, accuracy: 1e-12)
        XCTAssertEqual(blinked.eyes[0].rx, 11, accuracy: 1e-12)
        let shift = 22 * 0.08
        XCTAssertEqual(blinked.eyes[0].center.y, calm.eyes[0].center.y + cos(4 * d2r) * shift, accuracy: 1e-9)
        XCTAssertEqual(blinked.eyes[0].center.x, calm.eyes[0].center.x - sin(16 * d2r) * sin(4 * d2r) * shift, accuracy: 1e-9)
        XCTAssertEqual(blinked.mouth, calm.mouth, "a blink leaves the mouth alone")
        shut.blink = 3
        XCTAssertEqual(mark(shut), blinked, "clamped")
        shut.blink = -1
        XCTAssertEqual(mark(shut), calm, "clamped")

        let faces = Set(OrbAvatar.Face.stills.map { mark($0) })
        XCTAssertEqual(faces.count, OrbAvatar.Face.stills.count, "the stills differ")
    }

    /// core.js: white eyes unless lum(hex) > 0.55, then ink.
    func testFaceColourSwitchesAtTheLuminanceThreshold() {
        XCTAssertEqual(OrbColor.lum("#ffffff"), 1, accuracy: 1e-12)
        XCTAssertEqual(OrbColor.lum("#000000"), 0, accuracy: 1e-12)
        XCTAssertEqual(OrbColor.lum("#0a0a0a"), 10.0 / 255, accuracy: 1e-12)
        XCTAssertEqual(OrbColor.lum("#5aa9ff"), (0.2126 * 0x5a + 0.7152 * 0xa9 + 0.0722 * 0xff) / 255, accuracy: 1e-12)
        // Greys straddling the threshold: 140/255 = 0.549, 142/255 = 0.557.
        XCTAssertEqual(OrbAvatar.mark(body: .bear, colorHex: "#8c8c8c").faceColor, OrbAvatar.white)
        XCTAssertEqual(OrbAvatar.mark(body: .bear, colorHex: "#8e8e8e").faceColor, OrbAvatar.ink)
        XCTAssertEqual(OrbAvatar.mark(body: .bear, colorHex: "#0a0a0a").faceColor, "#ffffff")
        XCTAssertEqual(OrbAvatar.mark(body: .bear, colorHex: "#f2c94c").faceColor, "#141416")
        XCTAssertEqual(OrbAvatar.mark(body: .bear, colorHex: "#5aa9ff").faceColor, "#141416", "0.62: ink")
        let h = OrbColor.hex2("#5aa9ff")
        XCTAssertEqual(h.r, 0x5a)
        XCTAssertEqual(h.g, 0xa9)
        XCTAssertEqual(h.b, 0xff)
        let short = OrbColor.hex2("abc")
        XCTAssertEqual(short.r, 0xaa)
        XCTAssertEqual(short.g, 0xbb)
        XCTAssertEqual(short.b, 0xcc)
    }

    /// core.js tintOf: the light tint is lighter and the shadow darker in
    /// OKLab, both stay `#rrggbb`, and the budget leans to light on dark
    /// bodies and to shadow on light ones.
    func testTintsAreLighterAndDarkerInOKLab() {
        for hex in BlobAvatar.colors + ["#0a0a0a", "#ffffff", "#000000", "#3f9c8f"] {
            let L = OrbColor.lightness(hex)
            let light = OrbColor.tintOf(hex, 1)
            let shadow = OrbColor.tintOf(hex, -1)
            XCTAssertNotNil(BotAvatar.normalizedColor(light), hex)
            XCTAssertNotNil(BotAvatar.normalizedColor(shadow), hex)
            XCTAssertGreaterThanOrEqual(OrbColor.lightness(light), L - 1e-9, hex)
            XCTAssertLessThanOrEqual(OrbColor.lightness(shadow), L + 1e-9, hex)
            if L < 0.98 { XCTAssertGreaterThan(OrbColor.lightness(light), L + 0.02, hex) }
            if L > 0.02 { XCTAssertLessThan(OrbColor.lightness(shadow), L - 0.02, hex) }
            XCTAssertEqual(OrbColor.shiftL(hex, 0), hex, "a zero shift round-trips through OKLab")
            let m = OrbAvatar.mark(body: .bear, colorHex: hex)
            XCTAssertEqual(m.shade.light, light, hex)
            XCTAssertEqual(m.shade.shadow, shadow, hex)
        }
        // The budget: dark bodies get most of it as light (0.03 + 0.15·(1 − L)),
        // light bodies as shadow (0.04 + 0.05·L), each capped at 0.8 of the room.
        let dark = OrbColor.lightness("#0a0a0a")
        XCTAssertEqual(OrbColor.lightness(OrbColor.tintOf("#0a0a0a", 1)), dark + 0.03 + 0.15 * (1 - dark), accuracy: 0.01)
        XCTAssertEqual(OrbColor.lightness(OrbColor.tintOf("#0a0a0a", -1)), dark - (0.04 + 0.05 * dark), accuracy: 0.01)
        XCTAssertEqual(OrbColor.tintOf("#ffffff", 1), "#ffffff", "no room above white")
        XCTAssertEqual(OrbColor.tintOf("#000000", -1), "#000000", "no room below black")
        XCTAssertEqual(OrbColor.lightness(OrbColor.tintOf("#ffffff", -1)), 1 - 0.09, accuracy: 0.01)
        // Greys never leave the gamut, so these are the plain lightness shift
        // (cross-checked against core.js with the same numbers).
        XCTAssertEqual(OrbColor.tintOf("#0a0a0a", 1), "#2e2e2e")
        XCTAssertEqual(OrbColor.tintOf("#0a0a0a", -1), "#030303")
        XCTAssertEqual(OrbColor.tintOf("#ffffff", -1), "#e1e1e1")
        XCTAssertEqual(OrbColor.tintOf("#000000", 1), "#121212")
    }
}

// MARK: - Mock office: picking a look

final class MockAvatarTests: XCTestCase {
    func testUpdateShowsInMembersAndNotchThenResets() async throws {
        let broker = MockBroker(config: .init(typingDelay: .milliseconds(5), replyDelay: .milliseconds(5)))
        let seeded = try await broker.members().first { $0.slug == "hermes" }
        XCTAssertEqual(seeded?.avatar, BotAvatar(shape: "flower"), "mock seeds one partial override")

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
            try await broker.updateAvatar(slug: "nobody", avatar: BotAvatar(shape: "lemon"))
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
            return (200, Data(##"{"member":{"slug":"cos","name":"Chief of Staff","avatar":{"shape":"drop","color":"#3f9c8f"}}}"##.utf8))
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
        StubURLProtocol.handler = { _ in (400, Data("avatar shape must be one of bear, lemon\n".utf8)) }
        do {
            try await makeClient().updateAvatar(slug: "cos", avatar: BotAvatar(shape: "lemon"))
            XCTFail("expected an error")
        } catch let e as BrokerError {
            XCTAssertEqual(e, .http(400, "avatar shape must be one of bear, lemon"))
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
