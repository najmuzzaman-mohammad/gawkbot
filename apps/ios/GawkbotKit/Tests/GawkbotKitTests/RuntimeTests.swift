import Foundation
import XCTest
@testable import GawkbotKit

// MARK: - The model badge (a port of web/src/lib/botRuntime.test.ts)

final class BotRuntimeBadgeTests: XCTestCase {
    let opus = BotRuntime(harness: "claude-code", harnessName: "Claude Code", model: "claude-opus-5-5", modelLabel: "Opus 5.5", family: "claude")
    let astra = BotRuntime(harness: "codex", harnessName: "Codex CLI", modelLabel: "GPT-6 Astra")
    let gemini = BotRuntime(harness: "cli-agent", harnessName: "Gemini CLI")
    let local = BotRuntime(harness: "ollama", harnessName: "Ollama", modelLabel: "qwen2.5-coder:32b")

    private func code(_ label: String) -> String {
        BotRuntime(harness: "x", modelLabel: label).badgeText(.code)
    }

    func testDensitySaysMoreAsTheAvatarGetsBigger() {
        XCTAssertEqual(
            [12, 16, 24, 32, 43, 44, 64].map { BotRuntime.badgeDensity(avatarSize: $0) },
            [.dot, .code, .code, .word, .word, .full, .full]
        )
        XCTAssertEqual(BotRuntime.badgeDensity(avatarSize: 15.9), .dot)
        XCTAssertEqual(BotRuntime.badgeDensity(avatarSize: 31.9), .code)
        XCTAssertEqual(BotRuntime.badgeDensity(avatarSize: 43.9), .word)
    }

    func testSpellsTheModelOutWhereThereIsRoom() {
        XCTAssertEqual(opus.badgeText(.full), "Opus 5.5")
        XCTAssertEqual(opus.badgeText(.word), "Opus")
        XCTAssertEqual(opus.badgeText(.code), "Op")
        XCTAssertEqual(astra.badgeText(.word), "GPT-6")
        XCTAssertEqual(astra.badgeText(.code), "G6")
        XCTAssertEqual(local.badgeText(.code), "q2")
    }

    func testTellsOneModelFromAnotherInTwoCharacters() {
        // "O5" read as "05" on a small avatar, and Opus 5.5 and Sonnet 5.5
        // got the same digit. The code is the name, not the version.
        XCTAssertEqual(code("Opus 5.5"), "Op")
        XCTAssertEqual(code("Sonnet 5.5"), "So")
        XCTAssertEqual(code("Sonnet 4.6"), "So")
        XCTAssertEqual(code("Haiku 5.5"), "Ha")
        XCTAssertEqual(code("Fable 5.1"), "Fa")
        XCTAssertEqual(code("Gemini 2.5 Pro"), "Ge")
        XCTAssertEqual(code("GPT-6 Astra"), "G6")
        XCTAssertEqual(code("GPT-5.5"), "G5")
        XCTAssertEqual(code("o3"), "o3")
        // No code is a bare number or a zero-like "O" plus a digit.
        for label in ["Opus 5.5", "Sonnet 4.6", "Haiku 5.5", "Fable 5.1"] {
            XCTAssertNil(code(label).rangeOfCharacter(from: .decimalDigits), label)
        }
    }

    func testModelCodeEdges() {
        XCTAssertEqual(BotRuntime.modelCode("OPUS 5.5"), "Op", "the second letter is lower-cased")
        XCTAssertEqual(BotRuntime.modelCode("  Opus 5.5 "), "Op", "leading space is not a word")
        XCTAssertEqual(BotRuntime.modelCode("X"), "X", "one letter and no digit is the word itself")
        XCTAssertEqual(BotRuntime.modelCode("4o"), "4o", "a word that starts with a digit keeps its first two characters")
        XCTAssertEqual(BotRuntime.modelCode(""), "")
    }

    func testFallsBackToTheToolWhenTheModelIsUnknown() {
        XCTAssertEqual(gemini.badgeText(.full), "Gemini CLI")
        XCTAssertEqual(gemini.badgeText(.word), "Gemini")
        XCTAssertEqual(gemini.badgeText(.code), "GC")
        XCTAssertEqual(BotRuntime(harness: "exo").badgeText(.code), "ex")
        // A blank label or tool name is the same as none.
        XCTAssertEqual(BotRuntime(harness: "codex", harnessName: "  ", modelLabel: " ").badgeText(.full), "codex")
        XCTAssertEqual(BotRuntime(harness: "claude-code", harnessName: "Claude Code", modelLabel: "").badgeText(.code), "CC")
    }

    func testIsEmptyForADot() {
        XCTAssertEqual(opus.badgeText(.dot), "")
        XCTAssertEqual(gemini.badgeText(.dot), "")
    }

    func testTitleNamesTheModelAndTheTool() {
        XCTAssertEqual(opus.runtimeTitle, "Opus 5.5 in Claude Code")
        XCTAssertEqual(gemini.runtimeTitle, "Gemini CLI")
        XCTAssertEqual(BotRuntime(harness: "exo").runtimeTitle, "exo")
        XCTAssertEqual(opus.accessibilityLabel, "Runs on Opus 5.5 in Claude Code")
        XCTAssertEqual(gemini.accessibilityLabel, "Runs on Gemini CLI")
    }
}

// MARK: - Wire decoding

final class BotRuntimeDecodingTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    func testRuntimeDecodesTheContract() throws {
        let r = try decode(BotRuntime.self, #"{"harness":"claude-code","harness_name":"Claude Code","model":"claude-opus-5-5","model_label":"Opus 5.5","family":"claude","source":"observed"}"#)
        XCTAssertEqual(r, BotRuntime(harness: "claude-code", harnessName: "Claude Code", model: "claude-opus-5-5", modelLabel: "Opus 5.5", family: "claude", source: "observed"))
    }

    func testRuntimeToleratesMissingNullWrongAndExtraFields() throws {
        let bare = try decode(BotRuntime.self, #"{"harness":"codex"}"#)
        XCTAssertEqual(bare, BotRuntime(harness: "codex"))
        let odd = try decode(BotRuntime.self, #"{"harness":"codex","harness_name":null,"model":7,"model_label":null,"family":["gpt"],"source":"guessed","effort":"high"}"#)
        XCTAssertEqual(odd.harness, "codex")
        XCTAssertNil(odd.harnessName)
        XCTAssertNil(odd.model)
        XCTAssertNil(odd.modelLabel)
        XCTAssertNil(odd.family)
        XCTAssertEqual(odd.source, "guessed", "an unknown source is kept, not refused")
        XCTAssertThrowsError(try decode(BotRuntime.self, #"{"model_label":"Opus 5.5"}"#), "harness is the one required field")
    }

    func testMemberFromAnOldBrokerDecodesWithNoneOfTheNewFields() throws {
        let bot = try decode(Bot.self, #"{"slug":"cos","name":"Chief of Staff","role":"lead","built_in":true}"#)
        XCTAssertNil(bot.runtime)
        XCTAssertNil(bot.origin)
        XCTAssertNil(bot.session)
        XCTAssertFalse(bot.isSession)
    }

    func testMemberDecodesRuntimeOriginAndSession() throws {
        let bot = try decode(Bot.self, #"""
        {"slug":"cc-3f2a91c4","name":"Fix the flaky pairing test","origin":"session","runs_on":"this_machine","runs_on_detail":"Claude Code on this machine",
         "runtime":{"harness":"claude-code","harness_name":"Claude Code","model_label":"Opus 5.5","source":"observed"},
         "session":{"tool":"claude-code","project":"gawkbot","cwd":"/Users/sam/code/gawkbot","state":"working","updated_at":"2026-10-10T09:00:00Z","last_said":"Running the suite.","live":true},
         "something_new":{"a":[1,2,3]}}
        """#)
        XCTAssertTrue(bot.isSession)
        XCTAssertEqual(bot.runtime?.modelLabel, "Opus 5.5")
        XCTAssertEqual(bot.session, BotSession(tool: "claude-code", project: "gawkbot", cwd: "/Users/sam/code/gawkbot", state: "working", updatedAt: "2026-10-10T09:00:00Z", lastSaid: "Running the suite.", live: true))
    }

    func testAMalformedRuntimeOrSessionDoesNotCostTheMember() throws {
        let bot = try decode(Bot.self, #"{"slug":"pm","name":"PM","runtime":"claude","origin":5,"session":[1]}"#)
        XCTAssertEqual(bot.slug, "pm")
        XCTAssertNil(bot.runtime)
        XCTAssertNil(bot.origin)
        XCTAssertNil(bot.session)
        let nulls = try decode(Bot.self, #"{"slug":"pm","runtime":null,"origin":null,"session":null}"#)
        XCTAssertNil(nulls.runtime)
        XCTAssertNil(nulls.session)
        let noHarness = try decode(Bot.self, #"{"slug":"pm","runtime":{"model_label":"Opus 5.5"}}"#)
        XCTAssertNil(noHarness.runtime, "a runtime with no harness is read as unset")
    }

    func testSessionToleratesMissingAndWrongFields() throws {
        let empty = try decode(BotSession.self, "{}")
        XCTAssertEqual(empty, BotSession())
        XCTAssertFalse(empty.live, "a session that does not say it is live is closed")
        let odd = try decode(BotSession.self, #"{"tool":null,"project":3,"state":"napping","live":"yes","pid":991}"#)
        XCTAssertNil(odd.tool)
        XCTAssertNil(odd.project)
        XCTAssertEqual(odd.state, "napping")
        XCTAssertFalse(odd.live)
    }

    func testNotchAgentDecodesRuntimeAndOpen() throws {
        let agent = try decode(NotchAgent.self, #"{"slug":"cx-8be07d15","name":"Sponsor page copy","mood":"idle","kind":"session","open":true,"runtime":{"harness":"codex","harness_name":"Codex CLI","model_label":"GPT-6 Astra"}}"#)
        XCTAssertTrue(agent.isSession)
        XCTAssertEqual(agent.open, true)
        XCTAssertEqual(agent.runtime?.badgeText(.code), "G6")
        let old = try decode(NotchAgent.self, #"{"slug":"cos","name":"Chief of Staff","mood":"idle"}"#)
        XCTAssertNil(old.runtime)
        XCTAssertNil(old.open)
        let odd = try decode(NotchAgent.self, #"{"slug":"cos","runtime":[],"open":"maybe"}"#)
        XCTAssertNil(odd.runtime)
        XCTAssertNil(odd.open)
    }

    func testBrokerClientRosterKeepsWorkingAgainstAnOldOffice() async throws {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [StubURLProtocol.self]
        let client = BrokerClient(baseURL: URL(string: "http://100.64.0.5:7890")!, token: "tok", session: URLSession(configuration: cfg))
        StubURLProtocol.handler = { _ in
            (200, Data(#"{"members":[{"slug":"cos","name":"Chief of Staff","built_in":true},{"slug":"cc-1","name":"A session","origin":"session","runtime":{"harness":"claude-code"},"session":{"live":false}}]}"#.utf8))
        }
        let bots = try await client.members()
        XCTAssertEqual(bots.map(\.slug), ["cos", "cc-1"])
        XCTAssertNil(bots[0].runtime)
        XCTAssertEqual(bots[1].runtime?.harness, "claude-code")
        XCTAssertEqual(bots[1].sessionStatus, .closed)
    }
}

// MARK: - The lookup every avatar reads

final class BotRuntimeLookupTests: XCTestCase {
    let opus = BotRuntime(harness: "claude-code", harnessName: "Claude Code", modelLabel: "Opus 5.5")
    let sonnet = BotRuntime(harness: "claude-code", harnessName: "Claude Code", modelLabel: "Sonnet 5.5")

    func testEmptyLookupKnowsNoOne() {
        XCTAssertNil(BotRuntimeLookup.none["cos"])
        XCTAssertTrue(BotRuntimeLookup.none.isEmpty)
        XCTAssertEqual(BotRuntimeLookup.none.spokenName("Chief of Staff", slug: "cos"), "Chief of Staff")
    }

    func testTheInboxWinsWhereItHasARuntimeAndTheRosterCoversTheRest() {
        let lookup = BotRuntimeLookup(
            bots: [Bot(slug: "cos", name: "Chief of Staff", runtime: opus), Bot(slug: "pm", name: "PM", runtime: opus), Bot(slug: "bare", name: "Bare")],
            agents: [NotchAgent(slug: "cos", name: "Chief of Staff", mood: .idle, runtime: sonnet), NotchAgent(slug: "pm", name: "PM", mood: .idle)]
        )
        XCTAssertEqual(lookup["cos"], sonnet, "the fresher source wins")
        XCTAssertEqual(lookup["pm"], opus, "an inbox row with no runtime does not erase the roster's")
        XCTAssertNil(lookup["bare"])
        XCTAssertNil(lookup["nobody"])
    }

    func testSpokenNameGainsWhatItRunsOn() {
        let lookup = BotRuntimeLookup(bots: [Bot(slug: "cos", name: "Chief of Staff", runtime: opus), Bot(slug: "g", name: "Scout", runtime: BotRuntime(harness: "cli-agent", harnessName: "Gemini CLI"))])
        XCTAssertEqual(lookup.spokenName("Chief of Staff", slug: "cos"), "Chief of Staff, runs on Opus 5.5 in Claude Code")
        XCTAssertEqual(lookup.spokenName("Scout", slug: "g"), "Scout, runs on Gemini CLI")
        XCTAssertEqual(lookup.spokenName("Stranger", slug: "nobody"), "Stranger")
    }
}

// MARK: - Session members (a port of web/src/lib/sessionMember.ts)

final class SessionMemberTests: XCTestCase {
    private func session(_ slug: String, state: String? = nil, live: Bool = true, project: String? = nil) -> Bot {
        Bot(slug: slug, name: slug, origin: "session", session: BotSession(tool: "claude-code", project: project, state: state, live: live))
    }

    func testOnlyOriginSessionIsASession() {
        XCTAssertTrue(Bot(slug: "cc-1", name: "x", origin: "session").isSession)
        XCTAssertFalse(Bot(slug: "pm", name: "PM", origin: "user").isSession)
        XCTAssertFalse(Bot(slug: "pm", name: "PM").isSession)
        // A session object on a member that is not one does not make it one.
        XCTAssertFalse(Bot(slug: "pm", name: "PM", origin: "adopted", session: BotSession(live: true)).isSession)
    }

    func testGroupsSessionsBelowTheOfficeAgentsAndNeverMixesThem() {
        let roster = [
            Bot(slug: "cos", name: "Chief of Staff", builtIn: true, origin: "built_in"),
            session("cc-b"),
            Bot(slug: "designer", name: "Designer", origin: "user"),
            session("cx-a"),
            Bot(slug: "old", name: "From an old office"),
        ]
        let groups = SessionMember.group(roster)
        XCTAssertEqual(groups.agents.map(\.slug), ["cos", "designer", "old"])
        XCTAssertEqual(groups.sessions.map(\.slug), ["cc-b", "cx-a"], "each group keeps the order it came in")
        XCTAssertTrue(groups.agents.allSatisfy { !$0.isSession })
        XCTAssertTrue(groups.sessions.allSatisfy(\.isSession))
        XCTAssertEqual(groups.agents.count + groups.sessions.count, roster.count, "nobody is dropped")
    }

    func testNoSessionsMeansAnEmptyGroup() {
        let groups = SessionMember.group([Bot(slug: "cos", name: "Chief of Staff"), Bot(slug: "pm", name: "PM", origin: "user")])
        XCTAssertEqual(groups.agents.count, 2)
        XCTAssertTrue(groups.sessions.isEmpty)
        XCTAssertTrue(SessionMember.group([]).agents.isEmpty)
        XCTAssertEqual(SessionMember.sectionTitle, "Sessions on this Mac")
    }

    func testStatusComesOnlyFromTheSession() {
        XCTAssertEqual(session("a", state: "working").sessionStatusLabel, "Working")
        XCTAssertEqual(session("a", state: "your_turn").sessionStatusLabel, "Your turn")
        XCTAssertEqual(session("a", state: "quiet").sessionStatusLabel, "Quiet")
        XCTAssertEqual(session("a", state: nil).sessionStatusLabel, "Quiet")
        XCTAssertEqual(session("a", state: "something_new").sessionStatusLabel, "Quiet")
        // Not live is closed whatever the state says.
        XCTAssertEqual(session("a", state: "working", live: false).sessionStatusLabel, "Closed")
        XCTAssertEqual(Bot(slug: "a", name: "a", origin: "session").sessionStatusLabel, "Closed", "no session object at all")
        // The office's own activity never leaks in.
        var busy = session("a", state: "quiet")
        busy.status = "active"
        busy.task = "reviewing work packet"
        XCTAssertEqual(busy.sessionStatusLabel, "Quiet")
        XCTAssertEqual(SessionStatus.allCases.map(\.label), ["Working", "Your turn", "Quiet", "Closed"])
    }

    func testProjectIsTrimmedAndEmptyWhenUnknown() {
        XCTAssertEqual(session("a", project: " gawkbot ").sessionProject, "gawkbot")
        XCTAssertEqual(session("a").sessionProject, "")
        XCTAssertEqual(Bot(slug: "pm", name: "PM").sessionProject, "")
    }

    func testEmptyConversationLineDoesNotInviteAHelloToASession() {
        let line = Bot(slug: "cc-1", name: "Fix the flaky test", origin: "session").emptyConversationLine
        XCTAssertEqual(line, "Fix the flaky test runs in your terminal.")
        XCTAssertFalse(line.lowercased().contains("hi"), "no hello")
        XCTAssertEqual(Bot(slug: "cc-1", name: "", origin: "session").emptyConversationLine, "cc-1 runs in your terminal.")
        XCTAssertEqual(Bot(slug: "pm", name: "PM").emptyConversationLine, "Say hi. PM answers right here, like a person would.")
    }

    func testTheNotMessageableSentenceMatchesTheWeb() {
        XCTAssertEqual(SessionMember.notMessageable, "This session is open in your terminal on this Mac, so it cannot be messaged from here yet.")
    }

    func testAClosedSessionIsNotToldItIsOpen() {
        let open = "This session is open in your terminal on this Mac, so it cannot be messaged from here yet."
        let closed = "This session is closed. It cannot be messaged from here yet."
        XCTAssertEqual(SessionMember.notMessageable(live: true), open)
        XCTAssertEqual(SessionMember.notMessageable(live: nil), open, "unknown is not closed")
        XCTAssertEqual(SessionMember.notMessageable(live: false), closed)
        // On a member: live, closed (whatever the stale state says), and no
        // session object at all.
        XCTAssertEqual(session("a", state: "working", live: true).sessionNotMessageable, open)
        XCTAssertEqual(session("a", state: "working", live: false).sessionNotMessageable, closed)
        XCTAssertEqual(Bot(slug: "a", name: "a", origin: "session").sessionNotMessageable, open)
        XCTAssertFalse(closed.lowercased().contains("open"))
    }

    func testTheMockOfficeShowsBothSentences() async throws {
        let sessions = SessionMember.group(try await MockBroker().members()).sessions
        XCTAssertEqual(sessions.map(\.sessionNotMessageable), [SessionMember.notMessageable, SessionMember.notMessageable, SessionMember.notMessageableClosed])
    }
}

// MARK: - The mock office

final class MockBrokerRuntimeTests: XCTestCase {
    func testEveryMemberHasARuntimeAndTheSessionsAreGrouped() async throws {
        let roster = try await MockBroker().members()
        XCTAssertTrue(roster.allSatisfy { $0.runtime != nil })
        let groups = SessionMember.group(roster)
        XCTAssertEqual(groups.agents.count, 6)
        XCTAssertEqual(groups.sessions.map(\.sessionStatusLabel), ["Working", "Your turn", "Closed"])
        XCTAssertEqual(groups.sessions.map { $0.runtime?.badgeText(.full) }, ["Opus 5.5", "GPT-6 Astra", "Sonnet 5.5"])
        XCTAssertEqual(groups.sessions.map(\.sessionProject), ["gawkbot", "newsletter-site", "rsvp-app"])
    }

    func testNotchStateCarriesRuntimesAndMarksSessions() async throws {
        let state = try await MockBroker().notchState()
        XCTAssertTrue(state.agents.allSatisfy { $0.runtime != nil })
        let sessions = state.agents.filter(\.isSession)
        XCTAssertEqual(Set(sessions.map(\.slug)), [MockBroker.sessionWorking, MockBroker.sessionYourTurn, MockBroker.sessionClosed])
        XCTAssertEqual(state.agent(MockBroker.sessionClosed)?.open, false)
    }

    func testASessionAnswersWithTheBrokersOneLineAndNoTyping() async throws {
        let broker = MockBroker(config: .init(typingDelay: .milliseconds(5), replyDelay: .milliseconds(5)))
        let channel = DMChannel.slug(for: MockBroker.sessionWorking)
        try await broker.send(channel: channel, content: "hello?")
        let thread = try await broker.messages(channel: channel, sinceID: nil, limit: 10)
        XCTAssertEqual(thread.map(\.content), ["hello?", MockBroker.sessionReply])
    }
}
