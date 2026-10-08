import Foundation
import XCTest
@testable import GawkbotKit

// MARK: - /notch/state wire shape

final class NotchStateDecodingTests: XCTestCase {
    static let sample = #"""
    {"lead":"cos","lead_name":"Chief of Staff","lead_dm":"cos__human","mood":"needs_you","headline":"2 things need you",
     "agents":[
       {"slug":"cos","name":"Chief of Staff","mood":"needs_you","detail":"waiting on you","origin":"built_in","runs_on":"this_machine","is_lead":true},
       {"slug":"hermes","name":"Hermes","mood":"idle","origin":"imported","runs_on":"elsewhere","runs_on_detail":"Hermes gateway"},
       {"slug":"newbie","name":"Newbie","mood":"dancing"}
     ],
     "attention":[
       {"id":"req-2","kind":"interview","from":"cos","channel":"cos__human","question":"Which pipeline?","options":[{"id":"other","label":"Other","requires_text":true}],"created_at":"2026-10-08T09:00:00Z"},
       {"id":"req-1","kind":"approval","from":"hermes","from_name":"Hermes","channel":"hermes__human","title":"Post the recap?","question":"It goes to 312 people.","options":[{"id":"approve","label":"Approve"},{"id":"reject","label":"Reject"}],"recommended_id":"approve","blocking":true,"created_at":"2026-10-08T09:05:00Z"}
     ]}
    """#

    func testDecodesTheContract() throws {
        let state = try JSONDecoder().decode(NotchState.self, from: Data(Self.sample.utf8))
        XCTAssertEqual(state.lead, "cos")
        XCTAssertEqual(state.leadChannel, "cos__human")
        XCTAssertEqual(state.mood, .needsYou)
        XCTAssertEqual(state.agents.count, 3)
        XCTAssertTrue(state.agents[0].isLead)
        XCTAssertTrue(state.agents[1].runsElsewhere)
        XCTAssertEqual(state.agents[1].runsOnDetail, "Hermes gateway")
        XCTAssertEqual(state.agents[2].mood, .idle, "an unknown mood decodes as idle")
        XCTAssertFalse(state.agents[2].isLead)
        let req1 = try XCTUnwrap(state.attention.first { $0.id == "req-1" })
        XCTAssertTrue(req1.blocking)
        XCTAssertTrue(req1.isApproval)
        XCTAssertEqual(req1.recommendedOption?.id, "approve")
        XCTAssertEqual(req1.displayName, "Hermes")
        XCTAssertNotNil(req1.date)
        let req2 = try XCTUnwrap(state.attention.first { $0.id == "req-2" })
        XCTAssertFalse(req2.blocking)
        XCTAssertEqual(req2.displayName, "cos", "falls back to the slug without from_name")
        XCTAssertEqual(req2.options.first?.requiresText, true)
    }

    func testToleratesMissingArraysAndFields() throws {
        let state = try JSONDecoder().decode(NotchState.self, from: Data(#"{"mood":"idle","headline":"All quiet."}"#.utf8))
        XCTAssertEqual(state.agents, [])
        XCTAssertEqual(state.attention, [])
        XCTAssertNil(state.leadChannel)
        let bare = try JSONDecoder().decode(NotchAttention.self, from: Data(#"{"id":"r","from":"cos","question":"q"}"#.utf8))
        XCTAssertEqual(bare.kind, "question")
        XCTAssertEqual(bare.options, [])
        XCTAssertNil(bare.recommendedOption)
    }

    func testLeadChannelFallsBackToTheLeadSlug() {
        XCTAssertEqual(NotchState(lead: "cos").leadChannel, "cos__human")
        XCTAssertEqual(NotchState(lead: "cos", leadDM: "").leadChannel, "cos__human")
    }
}

// MARK: - Ordering, tags, headline

final class InboxOrderingTests: XCTestCase {
    private func item(_ id: String, blocking: Bool = false, at: String?) -> NotchAttention {
        NotchAttention(id: id, kind: "question", from: "cos", question: id, blocking: blocking, createdAt: at)
    }

    func testBlockingFirstThenOldestThenAsSent() {
        let items = [
            item("new", at: "2026-10-08T09:10:00Z"),
            item("old", at: "2026-10-08T09:00:00Z"),
            item("blocking-new", blocking: true, at: "2026-10-08T09:20:00Z"),
            item("blocking-old", blocking: true, at: "2026-10-08T09:01:00Z"),
            item("tie-a", at: "2026-10-08T09:30:00Z"),
            item("tie-b", at: "2026-10-08T09:30:00Z"),
        ]
        XCTAssertEqual(NotchState.order(items).map(\.id), ["blocking-old", "blocking-new", "old", "new", "tie-a", "tie-b"])
    }

    func testAgentsRankLeadFirstThenByMood() {
        let agents = [
            NotchAgent(slug: "a", name: "A", mood: .idle),
            NotchAgent(slug: "b", name: "B", mood: .error),
            NotchAgent(slug: "lead", name: "Lead", mood: .idle, isLead: true),
            NotchAgent(slug: "c", name: "C", mood: .needsYou),
            NotchAgent(slug: "d", name: "D", mood: .working),
        ]
        XCTAssertEqual(NotchState.rankAgents(agents).map(\.slug), ["lead", "c", "b", "d", "a"])
    }

    func testTags() {
        func agent(_ origin: String?, runsOn: String? = "this_machine", detail: String? = nil) -> NotchAgent {
            NotchAgent(slug: "x", name: "X", mood: .idle, origin: origin, runsOn: runsOn, runsOnDetail: detail)
        }
        XCTAssertEqual(agent("user").primaryTag, AgentTag(text: "yours", style: .yours))
        XCTAssertEqual(agent("adopted").primaryTag?.text, "adopted")
        XCTAssertEqual(agent("chief_of_staff").primaryTag?.text, "hired by CoS")
        XCTAssertEqual(agent("bot").primaryTag?.text, "hired by a bot")
        XCTAssertNil(agent(nil).primaryTag)
        XCTAssertNil(agent("something_new").primaryTag)

        let gateway = agent("imported", runsOn: "elsewhere", detail: "Hermes gateway")
        XCTAssertEqual(gateway.primaryTag, AgentTag(text: "elsewhere · Hermes gateway", style: .elsewhere))
        XCTAssertEqual(gateway.tags.map(\.text), ["imported", "elsewhere · Hermes gateway"])
        XCTAssertEqual(agent("user", runsOn: "elsewhere").whereTag?.text, "elsewhere")
        XCTAssertNil(agent("user").whereTag)
    }

    func testSummaryMatchesTheBrokerHeadline() {
        let one = NotchAttention(id: "r", kind: "approval", from: "designer", fromName: "Designer", title: "Start work?", question: "q")
        XCTAssertEqual(NotchState.summary(attention: [one], agents: []).headline, "Designer needs you: Start work?")
        XCTAssertEqual(NotchState.summary(attention: [one, one], agents: []).headline, "2 things need you")
        let err = NotchAgent(slug: "e", name: "E", mood: .error)
        let work = NotchAgent(slug: "w", name: "W", mood: .working)
        XCTAssertEqual(NotchState.summary(attention: [], agents: [err, work]).mood, .error)
        XCTAssertEqual(NotchState.summary(attention: [], agents: [work, work]).headline, "2 bots working")
        XCTAssertEqual(NotchState.summary(attention: [], agents: [NotchAgent(slug: "d", name: "D", mood: .done)]).mood, .done)
        XCTAssertEqual(NotchState.summary(attention: [], agents: []).headline, "All quiet. Nothing needs you.")
    }

    func testDerivedStateForOfficesWithoutNotch() {
        let bots = [
            Bot(slug: "cos", name: "Chief of Staff", builtIn: true),
            Bot(slug: "designer", name: "Designer", task: "drafting"),
            Bot(slug: "pm", name: "PM"),
        ]
        let reqs = [
            BotRequest(id: "r1", from: "designer", question: "Ship it?", status: "pending", createdAt: "2026-10-08T09:00:00Z"),
            BotRequest(id: "r0", from: "pm", question: "Done?", status: "answered"),
        ]
        let state = NotchState.derived(bots: bots, requests: reqs, working: ["pm"])
        XCTAssertEqual(state.lead, "cos")
        XCTAssertEqual(state.leadDM, "cos__human")
        XCTAssertEqual(state.attention.map(\.id), ["r1"])
        XCTAssertEqual(state.attention.first?.displayName, "Designer")
        XCTAssertEqual(state.agent("designer")?.mood, .needsYou)
        XCTAssertEqual(state.agent("pm")?.mood, .working)
        XCTAssertEqual(state.agent("cos")?.mood, .idle)
        XCTAssertEqual(state.agents.first?.slug, "cos")
        XCTAssertEqual(state.mood, .needsYou)
    }
}

// MARK: - Options, keyboard, selection, voice targets

final class InboxKeyboardTests: XCTestCase {
    func testEveryBindingMapsToItsCommand() {
        for binding in InboxKeymap.bindings {
            XCTAssertEqual(InboxKeymap.command(for: binding.key), binding.command, "\(binding.key)")
        }
    }

    func testTheMap() {
        XCTAssertEqual(InboxKeymap.command(for: .character("j")), .next)
        XCTAssertEqual(InboxKeymap.command(for: .downArrow), .next)
        XCTAssertEqual(InboxKeymap.command(for: .character("k")), .previous)
        XCTAssertEqual(InboxKeymap.command(for: .upArrow), .previous)
        XCTAssertEqual(InboxKeymap.command(for: .character("1")), .pick(1))
        XCTAssertEqual(InboxKeymap.command(for: .character("9")), .pick(9))
        XCTAssertEqual(InboxKeymap.command(for: .returnKey), .takeRecommended)
        XCTAssertEqual(InboxKeymap.command(for: .character("r")), .reply)
        XCTAssertEqual(InboxKeymap.command(for: .character("v")), .voice)
        XCTAssertEqual(InboxKeymap.command(for: .escape), .cancel)
        XCTAssertEqual(InboxKeymap.command(for: .character("J")), .next, "caps lock still navigates")
    }

    func testModifiedKeysAreLeftToTheSystem() {
        XCTAssertNil(InboxKeymap.command(for: .character("v"), modifiers: .command), "⌘V stays paste")
        XCTAssertNil(InboxKeymap.command(for: .character("r"), modifiers: .command))
        XCTAssertNil(InboxKeymap.command(for: .character("j"), modifiers: .shift))
        XCTAssertNil(InboxKeymap.command(for: .returnKey, modifiers: [.command]))
        XCTAssertNil(InboxKeymap.command(for: .character("1"), modifiers: .option))
    }

    func testUnmappedKeys() {
        XCTAssertNil(InboxKeymap.command(for: .character("0")))
        XCTAssertNil(InboxKeymap.command(for: .character("x")))
        XCTAssertNil(InboxKeymap.command(for: .character(" ")))
    }

    func testBindingsAreUniqueAndCoverNineOptions() {
        XCTAssertEqual(Set(InboxKeymap.bindings.map(\.id)).count, InboxKeymap.bindings.count)
        XCTAssertEqual(InboxKeymap.bindings.filter { if case .pick = $0.command { return true }; return false }.count, 9)
    }

    func testOptionShortcutsAndRecommended() {
        let a = NotchAttention(id: "r", kind: "approval", from: "x", question: "q", options: [
            InterviewOption(id: "approve", label: "Approve"),
            InterviewOption(id: "steer", label: "Steer", requiresText: true),
            InterviewOption(id: "reject", label: "Reject"),
        ], recommendedID: "steer")
        XCTAssertEqual(a.option(shortcut: 1)?.id, "approve")
        XCTAssertEqual(a.option(shortcut: 3)?.id, "reject")
        XCTAssertNil(a.option(shortcut: 0))
        XCTAssertNil(a.option(shortcut: 4))
        XCTAssertEqual(a.recommendedOption?.id, "steer")
        XCTAssertTrue(a.isRecommended(a.options[1]))
        // The recommended option needs text, so a swipe takes "approve".
        XCTAssertEqual(a.quickOption?.id, "approve")

        var b = a
        b.recommendedID = "nope"
        XCTAssertNil(b.recommendedOption)
        b.options = [InterviewOption(id: "other", label: "Other", requiresText: true)]
        XCTAssertNil(b.quickOption)
    }

    func testCursor() {
        let ids = ["a", "b", "c"]
        XCTAssertEqual(InboxCursor.move(from: nil, in: ids, by: 1), "a")
        XCTAssertEqual(InboxCursor.move(from: nil, in: ids, by: -1), "c")
        XCTAssertEqual(InboxCursor.move(from: "a", in: ids, by: 1), "b")
        XCTAssertEqual(InboxCursor.move(from: "c", in: ids, by: 1), "c", "stops at the end")
        XCTAssertEqual(InboxCursor.move(from: "a", in: ids, by: -1), "a", "stops at the start")
        XCTAssertEqual(InboxCursor.move(from: "gone", in: ids, by: 1), "a")
        XCTAssertNil(InboxCursor.move(from: "a", in: [], by: 1))

        XCTAssertEqual(InboxCursor.reconcile(selected: "b", previous: ids, current: ["c", "b"]), "b")
        XCTAssertEqual(InboxCursor.reconcile(selected: "b", previous: ids, current: ["a", "c"]), "c", "the next card slides into place")
        XCTAssertEqual(InboxCursor.reconcile(selected: "c", previous: ids, current: ["a", "b"]), "b")
        XCTAssertNil(InboxCursor.reconcile(selected: "a", previous: ids, current: []))
        XCTAssertNil(InboxCursor.reconcile(selected: nil, previous: ids, current: ids))
    }

    func testVoiceTargets() {
        let state = NotchState(lead: "cos", leadName: "Chief of Staff", leadDM: "cos__human")
        let q = NotchAttention(id: "req-1", kind: "question", from: "hermes", fromName: "Hermes", question: "Post?")
        let hermes = NotchAgent(slug: "hermes", name: "Hermes", mood: .idle, runsOn: "elsewhere")
        let cos = NotchAgent(slug: "cos", name: "Chief of Staff", mood: .idle, isLead: true)

        XCTAssertEqual(VoiceTarget.choices(selected: nil, agent: nil, state: state), [.message(channel: "cos__human", agentName: "Chief of Staff")])
        XCTAssertEqual(VoiceTarget.choices(selected: q, agent: hermes, state: state), [
            .answer(requestID: "req-1", agentName: "Hermes"),
            .message(channel: "hermes__human", agentName: "Hermes"),
            .message(channel: "cos__human", agentName: "Chief of Staff"),
        ])
        XCTAssertEqual(VoiceTarget.choices(selected: nil, agent: cos, state: state).count, 1, "the lead is not offered twice")
        XCTAssertEqual(VoiceTarget.choices(selected: nil, agent: nil, state: nil).first?.channel, "cos__human")
        XCTAssertEqual(VoiceTarget.answer(requestID: "r", agentName: "Hermes").label, "Answer Hermes")
        XCTAssertNil(VoiceTarget.answer(requestID: "r", agentName: "Hermes").channel)
    }
}

// MARK: - Sounds

final class InboxEventsTests: XCTestCase {
    private func state(_ attention: [NotchAttention], _ agents: [NotchAgent]) -> NotchState {
        NotchState(agents: agents, attention: attention)
    }

    func testFirstPollIsSilent() {
        let s = state([NotchAttention(id: "r", kind: "approval", from: "x", question: "q")], [])
        XCTAssertEqual(InboxEvents.cues(from: nil, to: s), [])
    }

    func testNewQuestionsAndMoodChanges() {
        let old = state([], [NotchAgent(slug: "a", name: "A", mood: .working), NotchAgent(slug: "b", name: "B", mood: .working)])
        let new = state(
            [
                NotchAttention(id: "q", kind: "interview", from: "a", question: "q"),
                NotchAttention(id: "p", kind: "approval", from: "b", question: "p"),
            ],
            [NotchAgent(slug: "a", name: "A", mood: .done), NotchAgent(slug: "b", name: "B", mood: .error), NotchAgent(slug: "c", name: "C", mood: .error)]
        )
        XCTAssertEqual(InboxEvents.cues(from: old, to: new), [.approvalNeeded, .newQuestion, .error, .done])
        XCTAssertEqual(InboxEvents.cues(from: new, to: new), [], "nothing changed, nothing plays")
    }
}

final class CartoonSynthTests: XCTestCase {
    func testEveryCueRendersAShortCleanSound() {
        for cue in SoundCue.allCases {
            let samples = CartoonSynth.render(cue)
            XCTAssertFalse(samples.isEmpty, "\(cue)")
            XCTAssertLessThan(Double(samples.count) / CartoonSynth.sampleRate, 1.0, "\(cue) stays under a second")
            XCTAssertTrue(samples.allSatisfy { $0.isFinite }, "\(cue)")
            let peak = samples.map { abs($0) }.max() ?? 0
            XCTAssertGreaterThan(peak, 0.05, "\(cue) is audible")
            XCTAssertLessThanOrEqual(peak, 0.8001, "\(cue) never clips")
            XCTAssertLessThan(abs(samples[0]), 0.01, "\(cue) starts without a click")
            XCTAssertLessThan(abs(samples[samples.count - 1]), 0.01, "\(cue) ends in silence")
        }
    }

    func testCuesSoundDifferent() {
        let rendered = SoundCue.allCases.map { CartoonSynth.render($0) }
        for i in rendered.indices {
            for j in rendered.indices where j > i {
                XCTAssertNotEqual(rendered[i], rendered[j], "\(SoundCue.allCases[i]) vs \(SoundCue.allCases[j])")
            }
        }
    }

    func testPitchDirection() {
        // "doo-dee" ascends; "wah-wah" descends.
        let up = CartoonSynth.tones(for: .approvalNeeded).map(\.from)
        XCTAssertGreaterThan(up.last ?? 0, up.first ?? 0)
        let down = CartoonSynth.tones(for: .error)
        XCTAssertLessThan(down[1].to, down[0].from)
        XCTAssertGreaterThan(CartoonSynth.tones(for: .newQuestion)[0].to, CartoonSynth.tones(for: .newQuestion)[0].from)
    }

    func testPriorityOrder() {
        XCTAssertEqual(SoundCue.allCases.sorted { $0.priority < $1.priority }.first, .approvalNeeded)
    }
}

// MARK: - Smooth avatar parity with web/src/lib/blobAvatarSmooth.ts

final class SmoothBlobParityTests: XCTestCase {
    // Computed with: cd web && bun -e 'import { blobShapeIndex, blobColor } from "./src/lib/blobAvatar"; …'
    func testShapeAndColourMatchTheWeb() {
        let expected: [(String, Int, String)] = [
            ("cos", 4, "#8b6bb1"),
            ("designer", 4, "#6b7fd7"),
            ("gtm-lead", 2, "#c08a3e"),
            ("founding-engineer", 1, "#4d8bb8"),
            ("prospect-scout", 2, "#5f9e6b"),
            ("pm", 6, "#6f8f43"),
            ("hermes", 3, "#8a7a2e"),
            ("scout", 5, "#a35a45"),
            ("openclaw", 6, "#a35a45"),
            ("ceo", 6, "#c08a3e"),
        ]
        for (slug, shape, color) in expected {
            XCTAssertEqual(BlobAvatar.shapeIndex(slug), shape, slug)
            XCTAssertEqual(BlobAvatar.colorHex(slug), color, slug)
            XCTAssertEqual(SmoothBlob.mark(slug).colorHex, color, slug)
        }
    }

    func testOutlineMatchesTheWeb() {
        // silhouetteOutline(4) from the TS.
        let web: [[Double]] = [[5.5,0],[10.5,0],[11,0.5],[12,1.5],[13,2.5],[13,3.5],[13,4.5],[13,5.5],[13,6.5],[13,7.5],[13,8.5],[13,9.5],[13,10.5],[13,11.5],[13,12.5],[13,13.5],[12,14.5],[11,15.5],[10.5,16],[5.5,16],[5,15.5],[4,14.5],[3,13.5],[3,12.5],[3,11.5],[3,10.5],[3,9.5],[3,8.5],[3,7.5],[3,6.5],[3,5.5],[3,4.5],[3,3.5],[3,2.5],[4,1.5],[5,0.5]]
        XCTAssertEqual(SmoothBlob.outline(shapeIndex: 4).map { [$0.x, $0.y] }, web)
    }

    /// The body subpath's numbers in SVG order (M x y, then C c1x c1y c2x c2y x y …),
    /// extracted from smoothBlob(slug).d, which rounds to 3 decimals.
    static let webBodies: [String: [Double]] = [
        "cos": [5.5,0,6.75,-0.417,9.25,-0.417,10.5,0,11.75,0.417,12.583,0.25,13,2.5,13.417,4.75,13.417,11.25,13,13.5,12.583,15.75,11.75,15.583,10.5,16,9.25,16.417,6.75,16.417,5.5,16,4.25,15.583,3.417,15.75,3,13.5,2.583,11.25,2.583,4.75,3,2.5,3.417,0.25,4.25,0.417,5.5,0],
        "gtm-lead": [7.5,1,7.917,0.75,8.083,0.75,8.5,1,8.917,1.25,9.75,2.083,10,2.5,10.25,2.917,9.333,2.667,10,3.5,10.667,4.333,13.333,6.667,14,7.5,14.667,8.333,13.833,8.167,14,8.5,14.167,8.833,14.833,9,15,9.5,15.167,10,15.333,10.833,15,11.5,14.667,12.167,13.667,13,13,13.5,12.333,14,11.417,14.25,11,14.5,10.583,14.75,11.417,14.917,10.5,15,9.583,15.083,6.417,15.083,5.5,15,4.583,14.917,5.417,14.75,5,14.5,4.583,14.25,3.667,14,3,13.5,2.333,13,1.333,12.167,1,11.5,0.667,10.833,0.833,10,1,9.5,1.167,9,1.833,8.833,2,8.5,2.167,8.167,1.333,8.333,2,7.5,2.667,6.667,5.333,4.333,6,3.5,6.667,2.667,5.75,2.917,6,2.5,6.25,2.083,7.083,1.25,7.5,1],
        "founding-engineer": [6.5,1,7.083,0.917,8.917,0.917,9.5,1,10.083,1.083,9.583,1.25,10,1.5,10.417,1.75,11.333,2,12,2.5,12.667,3,13.667,4,14,4.5,14.333,5,13.833,5.167,14,5.5,14.167,5.833,14.833,5,15,6.5,15.167,8,15.083,13.083,15,14.5,14.917,15.917,16.75,14.917,14.5,15,12.25,15.083,3.75,15.083,1.5,15,-0.75,14.917,1.083,15.917,1,14.5,0.917,13.083,0.833,8,1,6.5,1.167,5,1.833,5.833,2,5.5,2.167,5.167,1.667,5,2,4.5,2.333,4,3.333,3,4,2.5,4.667,2,5.583,1.75,6,1.5,6.417,1.25,5.917,1.083,6.5,1],
    ]

    func testSplineMatchesTheWeb() {
        for (slug, web) in Self.webBodies {
            let mark = SmoothBlob.mark(slug)
            var mine = [mark.start.x, mark.start.y]
            for s in mark.segments {
                mine += [s.control1.x, s.control1.y, s.control2.x, s.control2.y, s.end.x, s.end.y]
            }
            XCTAssertEqual(mine.count, web.count, slug)
            for (a, b) in zip(mine, web) {
                XCTAssertEqual(a, b, accuracy: 0.0006, slug)
            }
        }
    }

    func testEyesMatchTheWeb() {
        // smoothBlob("cos").eyes and smoothBlob("cos", 0).eyes
        let open = SmoothBlob.eyes(openness: 1)
        XCTAssertEqual(open.count, 2)
        XCTAssertEqual(open[0].x, 5.1, accuracy: 1e-9)
        XCTAssertEqual(open[1].x, 9.1, accuracy: 1e-9)
        XCTAssertEqual(open[0].y, 5)
        XCTAssertEqual(open[0].width, 1.8, accuracy: 1e-9)
        XCTAssertEqual(open[0].height, 4)
        XCTAssertEqual(open[0].cornerRadius, 0.9, accuracy: 1e-9)
        XCTAssertEqual(SmoothBlob.eyes(openness: 0)[0].height, 2, "narrowed, never shut")
    }

    func testEveryShapeTraces() {
        for i in 0..<BlobAvatar.silhouettes.count {
            let outline = SmoothBlob.outline(shapeIndex: i)
            XCTAssertGreaterThan(outline.count, 4)
            for p in outline {
                XCTAssertTrue((0...16).contains(p.x) && (0...16).contains(p.y))
            }
        }
        XCTAssertEqual(SmoothBlob.outline(shapeIndex: 12), SmoothBlob.outline(shapeIndex: 4), "wraps like the web's modulo")
    }
}

// MARK: - Mood motion

final class MoodMotionTests: XCTestCase {
    func testReduceMotionIsStill() {
        for t in stride(from: 0.0, to: 5.0, by: 0.1) {
            XCTAssertEqual(MoodMotion.pose(for: nil, time: t), .rest)
        }
    }

    func testEachMoodMovesAndStaysSmall() {
        for mood in Mood.allCases {
            var moved = false
            for t in stride(from: 0.0, to: 5.0, by: 0.02) {
                let p = MoodMotion.pose(for: mood, time: t)
                if p != .rest { moved = true }
                XCTAssertLessThanOrEqual(abs(p.dx), 0.05, "\(mood)")
                XCTAssertLessThanOrEqual(abs(p.dy), 0.2, "\(mood)")
                XCTAssertLessThanOrEqual(abs(p.rotation), 8, "\(mood)")
                XCTAssertEqual(p.scaleX, 1, accuracy: 0.06, "\(mood)")
                XCTAssertEqual(p.scaleY, 1, accuracy: 0.06, "\(mood)")
            }
            XCTAssertTrue(moved, "\(mood) animates")
        }
    }

    func testOnlyWorkingBlinks() {
        let blinks = stride(from: 0.0, to: 3.0, by: 0.01).contains { MoodMotion.pose(for: .working, time: $0).openness == 0 }
        XCTAssertTrue(blinks)
        let idleBlinks = stride(from: 0.0, to: 3.0, by: 0.01).contains { MoodMotion.pose(for: .idle, time: $0).openness == 0 }
        XCTAssertFalse(idleBlinks)
    }
}

// MARK: - Mock office

final class MockNotchTests: XCTestCase {
    func testCannedStateCoversTheInbox() async throws {
        let broker = MockBroker(config: .init(typingDelay: .milliseconds(5), replyDelay: .milliseconds(5)))
        let state = try await broker.notchState()
        XCTAssertEqual(state.attention.map(\.id), ["request-25", "request-26", "request-27"], "blocking first, then oldest")
        XCTAssertTrue(state.attention[0].blocking)
        XCTAssertEqual(state.leadChannel, "cos__human")
        XCTAssertEqual(state.agents.first?.slug, "cos")
        XCTAssertEqual(state.agent("hermes")?.primaryTag?.text, "elsewhere · Hermes gateway")
        XCTAssertEqual(state.agent("hermes")?.mood, .needsYou)
        XCTAssertEqual(Set(state.agents.map(\.mood)), [.needsYou, .working, .done, .error], "several moods on show")
        XCTAssertEqual(state.headline, "3 things need you")
        XCTAssertTrue(state.attention.contains { $0.options.contains { $0.requiresText == true } })
    }

    func testCustomAnswerClearsTheCardAndWriteInsNeedText() async throws {
        let broker = MockBroker(config: .init(typingDelay: .milliseconds(5), replyDelay: .milliseconds(5)))
        do {
            try await broker.answer(requestID: "request-26", choiceID: "other", text: nil)
            XCTFail("a write-in option without text should be refused")
        } catch let e as BrokerError {
            XCTAssertEqual(e, .http(400, "custom_text required for this response"))
        }
        try await broker.answer(requestID: "request-27", customText: "Hold until Friday")
        let state = try await broker.notchState()
        XCTAssertEqual(state.attention.map(\.id), ["request-25", "request-26"])
        let thread = try await broker.messages(channel: DMChannel.slug(for: "hermes"), sinceID: nil, limit: 50)
        XCTAssertTrue(thread.contains { $0.content.contains("Hold until Friday") })
    }
}

// MARK: - BrokerClient: the two new calls

final class BrokerClientNotchTests: XCTestCase {
    private func makeClient() -> BrokerClient {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [StubURLProtocol.self]
        return BrokerClient(baseURL: URL(string: "http://100.64.0.5:7890")!, token: "tok", session: URLSession(configuration: cfg))
    }

    func testNotchStateIsAnAuthorizedGet() async throws {
        StubURLProtocol.handler = { req in
            XCTAssertEqual(req.httpMethod, "GET")
            XCTAssertEqual(req.url?.path, "/notch/state")
            XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
            return (200, Data(NotchStateDecodingTests.sample.utf8))
        }
        let state = try await makeClient().notchState()
        XCTAssertEqual(state.attention.count, 2)
    }

    func testCustomAnswerSendsOnlyTheText() async throws {
        StubURLProtocol.handler = { req in
            XCTAssertEqual(req.url?.path, "/requests/answer")
            let data = req.httpBody ?? bodyStreamData(req)
            let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
            XCTAssertEqual(body["id"] as? String, "req-2")
            XCTAssertEqual(body["custom_text"] as? String, "Use the one we have")
            XCTAssertNil(body["choice_id"])
            return (200, Data(#"{"ok":true}"#.utf8))
        }
        try await makeClient().answer(requestID: "req-2", customText: "Use the one we have")
    }
}

/// URLProtocol hands POST bodies over as a stream; read it back.
private func bodyStreamData(_ req: URLRequest) -> Data {
    guard let stream = req.httpBodyStream else { return Data() }
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while stream.hasBytesAvailable {
        let n = stream.read(&buffer, maxLength: buffer.count)
        if n <= 0 { break }
        data.append(buffer, count: n)
    }
    return data
}
