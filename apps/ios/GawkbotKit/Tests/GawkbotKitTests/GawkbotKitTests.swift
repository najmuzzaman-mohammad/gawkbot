import Foundation
import XCTest
@testable import GawkbotKit

final class DMChannelTests: XCTestCase {
    func testSlugSortsParticipantsLikeTheBroker() {
        XCTAssertEqual(DMChannel.slug(for: "cos"), "cos__human")
        XCTAssertEqual(DMChannel.slug(for: "pm"), "human__pm")
        XCTAssertEqual(DMChannel.slug(for: "prospect-scout"), "human__prospect-scout")
        XCTAssertEqual(DMChannel.slug(for: " Designer "), "designer__human")
    }

    func testBotInChannel() {
        XCTAssertEqual(DMChannel.bot(in: "cos__human"), "cos")
        XCTAssertEqual(DMChannel.bot(in: "human__pm"), "pm")
        XCTAssertNil(DMChannel.bot(in: "cos__designer"))
        XCTAssertNil(DMChannel.bot(in: "team"))
    }
}

final class ModelDecodingTests: XCTestCase {
    func testMessageDecodesWireShape() throws {
        let json = #"{"id":"msg-1","from":"cos","channel":"cos__human","content":"hi","timestamp":"2026-09-08T05:28:25Z","reply_to":"msg-0","thread_count":2}"#
        let m = try JSONDecoder().decode(ChatMessage.self, from: Data(json.utf8))
        XCTAssertEqual(m.replyTo, "msg-0")
        XCTAssertEqual(m.threadCount, 2)
        XCTAssertFalse(m.isFromHuman)
        XCTAssertNotNil(m.date)
    }

    func testHumanSenders() {
        XCTAssertTrue(ChatMessage(id: "1", from: "you", channel: "c", content: "x", timestamp: "").isFromHuman)
        XCTAssertTrue(ChatMessage(id: "1", from: "human", channel: "c", content: "x", timestamp: "").isFromHuman)
        XCTAssertFalse(ChatMessage(id: "1", from: "cos", channel: "c", content: "x", timestamp: "").isFromHuman)
    }

    func testRequestButtonsFallBackToApproveReject() throws {
        let json = #"{"id":"request-25","from":"designer","question":"Start?","status":"pending","choices":[{"id":"approve","label":"Approve"},{"id":"reject_with_steer","label":"Reject with steer","requires_text":true}]}"#
        let r = try JSONDecoder().decode(BotRequest.self, from: Data(json.utf8))
        XCTAssertEqual(r.buttons.map(\.id), ["approve", "reject_with_steer"])
        XCTAssertEqual(r.buttons[1].requiresText, true)
        XCTAssertTrue(r.isPending)
        let bare = BotRequest(id: "r", from: "cos", question: "q")
        XCTAssertEqual(bare.buttons.map(\.label), ["Approve", "Reject"])
    }
}

final class SSEParserTests: XCTestCase {
    func testParsesNamedEventsAndDefaultsToMessage() {
        var p = SSEParser()
        XCTAssertNil(p.feed(line: "event: activity"))
        XCTAssertNil(p.feed(line: "data: {\"slug\":\"cos\",\"status\":\"active\"}"))
        let e = p.feed(line: "")
        XCTAssertEqual(e, SSEParser.Event(name: "activity", data: "{\"slug\":\"cos\",\"status\":\"active\"}"))

        XCTAssertNil(p.feed(line: "data: {\"id\":\"m1\",\"from\":\"cos\",\"channel\":\"cos__human\",\"content\":\"4.\",\"timestamp\":\"2026-09-08T00:00:00Z\"}"))
        let m = p.feed(line: "\r")
        XCTAssertEqual(m?.name, "message")
    }

    func testIgnoresCommentsAndJoinsMultilineData() {
        var p = SSEParser()
        XCTAssertNil(p.feed(line: ": keepalive"))
        XCTAssertNil(p.feed(line: ""))
        XCTAssertNil(p.feed(line: "data: a"))
        XCTAssertNil(p.feed(line: "data: b"))
        XCTAssertEqual(p.feed(line: "")?.data, "a\nb")
    }

    func testDecoderTypesKnownEvents() {
        let msg = BrokerEventDecoder.decode(SSEParser.Event(name: "message", data: #"{"id":"m1","from":"cos","channel":"cos__human","content":"4.","timestamp":"2026-09-08T00:00:00Z"}"#))
        if case let .message(m)? = msg { XCTAssertEqual(m.content, "4.") } else { XCTFail("expected message") }
        let act = BrokerEventDecoder.decode(SSEParser.Event(name: "activity", data: #"{"slug":"cos","status":"active","activity":"typing"}"#))
        if case let .activity(a)? = act { XCTAssertTrue(a.isWorking) } else { XCTFail("expected activity") }
        XCTAssertEqual(BrokerEventDecoder.decode(SSEParser.Event(name: "governor", data: "{}")), .other(name: "governor"))
        XCTAssertNil(BrokerEventDecoder.decode(SSEParser.Event(name: "message", data: "not json")))
    }
}

final class PairingTests: XCTestCase {
    func testParsesPairLink() {
        let p = Pairing.parse("gawkbot://pair?url=http%3A%2F%2F100.64.0.5%3A7890&token=abc123")
        XCTAssertEqual(p?.brokerURL.absoluteString, "http://100.64.0.5:7890")
        XCTAssertEqual(p?.token, "abc123")
        XCTAssertEqual(p?.link, "gawkbot://pair?url=http://100.64.0.5:7890&token=abc123")
    }

    func testParsesBareBrokerURLWithToken() {
        let p = Pairing.parse("https://office.example.ts.net:7890?token=t0k")
        XCTAssertEqual(p?.brokerURL.absoluteString, "https://office.example.ts.net:7890")
        XCTAssertEqual(p?.token, "t0k")
    }

    func testRejectsGarbage() {
        XCTAssertNil(Pairing.parse("hello"))
        XCTAssertNil(Pairing.parse("gawkbot://pair?url=http://x"))
        XCTAssertNil(Pairing.make(urlString: "", token: "t"))
        XCTAssertNil(Pairing.make(urlString: "ftp://x", token: "t"))
    }

    func testCleartextOnlyForPrivateHosts() {
        XCTAssertNotNil(Pairing.make(urlString: "http://100.64.0.5:7890", token: "t"), "Tailscale address")
        XCTAssertNotNil(Pairing.make(urlString: "http://192.168.1.20:7890", token: "t"), "LAN")
        XCTAssertNotNil(Pairing.make(urlString: "http://office.local:7890", token: "t"))
        XCTAssertNotNil(Pairing.make(urlString: "http://office.tail1234.ts.net:7890", token: "t"))
        XCTAssertNotNil(Pairing.make(urlString: "http://localhost:7890", token: "t"))
        XCTAssertNil(Pairing.make(urlString: "http://gawk.bot:7890", token: "t"), "public host over http")
        XCTAssertNil(Pairing.make(urlString: "http://8.8.8.8:7890", token: "t"))
        XCTAssertNotNil(Pairing.make(urlString: "https://gawk.bot", token: "t"), "public host over https")
        XCTAssertNil(Pairing.parse("gawkbot://pair?url=http%3A%2F%2Fevil.example.com&token=x"))
    }

    func testMakeAddsSchemeAndTrimsSlash() {
        let p = Pairing.make(urlString: "100.64.0.5:7890/", token: " tok ")
        XCTAssertEqual(p?.brokerURL.absoluteString, "http://100.64.0.5:7890")
        XCTAssertEqual(p?.token, "tok")
    }
}

final class BlobAvatarParityTests: XCTestCase {
    // Values computed from web/src/lib/blobAvatar.ts (FNV-1a over UTF-16
    // code units): slug → hash, shape index, colour.
    func testHashesMatchTheWebImplementation() {
        XCTAssertEqual(BlobAvatar.hash("cos"), 4_220_379_804)
        XCTAssertEqual(BlobAvatar.hash("designer"), 3_572_601_220)
        XCTAssertEqual(BlobAvatar.hash("founding-engineer"), 549_060_673)
    }

    func testShapeAndColourMatchTheWeb() {
        XCTAssertEqual(BlobAvatar.shapeIndex("cos"), 4)
        XCTAssertEqual(BlobAvatar.colorHex("cos"), "#8b6bb1")
        XCTAssertEqual(BlobAvatar.shapeIndex("gtm-lead"), 2)
        XCTAssertEqual(BlobAvatar.colorHex("gtm-lead"), "#c08a3e")
        XCTAssertEqual(BlobAvatar.shapeIndex("pm"), 6)
        XCTAssertEqual(BlobAvatar.colorHex("pm"), "#6f8f43")
        XCTAssertEqual(BlobAvatar.colorHex(" COS "), BlobAvatar.colorHex("cos"))
    }

    func testEyesArePunchedOutOfTheBody() {
        let cells = BlobAvatar.cells("cos", openness: 1)
        XCTAssertFalse(cells.contains { $0.x == 5 && $0.y == 5 })
        XCTAssertFalse(cells.contains { $0.x == 10 && $0.y == 8 })
        XCTAssertTrue(cells.contains { $0.x == 8 && $0.y == 8 })
        XCTAssertEqual(BlobAvatar.eyes(openness: 0).height, 2)
        XCTAssertEqual(BlobAvatar.eyes(openness: 1).height, 4)
    }
}

final class MockBrokerTests: XCTestCase {
    func testSendGetsATypingSignalThenAReply() async throws {
        let broker = MockBroker(config: .init(typingDelay: .milliseconds(10), replyDelay: .milliseconds(30)))
        let channel = DMChannel.slug(for: "cos")
        let stream = broker.events()
        var iterator = stream.makeAsyncIterator()
        _ = await iterator.next() // ready
        let sent = try await broker.send(channel: channel, content: "quick check: are you there?")
        XCTAssertTrue(sent.isFromHuman)

        var sawEcho = false, sawTyping = false, reply: ChatMessage?
        for _ in 0..<6 {
            guard let ev = await iterator.next() else { break }
            switch ev {
            case let .message(m) where m.id == sent.id: sawEcho = true
            case let .activity(a) where a.slug == "cos" && a.isWorking: sawTyping = true
            case let .message(m) where m.from == "cos": reply = m
            default: break
            }
            if reply != nil { break }
        }
        XCTAssertTrue(sawEcho)
        XCTAssertTrue(sawTyping)
        XCTAssertEqual(reply?.content, "Yes, here. What do you need?")
        let history = try await broker.messages(channel: channel, sinceID: nil, limit: 50)
        XCTAssertEqual(history.last?.id, reply?.id)
    }

    func testAnsweringARequestRemovesItAndAcksInTheThread() async throws {
        let broker = MockBroker(config: .init(typingDelay: .milliseconds(5), replyDelay: .milliseconds(5)))
        let before = try await broker.requests(channel: nil)
        XCTAssertEqual(before.map(\.id), ["request-25"])
        try await broker.answer(requestID: "request-25", choiceID: "approve", text: nil)
        let after = try await broker.requests(channel: nil)
        XCTAssertTrue(after.isEmpty)
        let thread = try await broker.messages(channel: DMChannel.slug(for: "designer"), sinceID: nil, limit: 50)
        XCTAssertTrue(thread.contains { $0.kind == "system" && $0.content.hasPrefix("Approved @designer") })
    }
}

// MARK: - BrokerClient against a stubbed transport

final class StubURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) -> (Int, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let (code, body) = StubURLProtocol.handler?(request) ?? (500, Data())
        let resp = HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class BrokerClientTests: XCTestCase {
    private func makeClient() -> BrokerClient {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [StubURLProtocol.self]
        return BrokerClient(baseURL: URL(string: "http://100.64.0.5:7890")!, token: "tok", session: URLSession(configuration: cfg))
    }

    func testMembersSendsBearerAndDropsTheHuman() async throws {
        StubURLProtocol.handler = { req in
            XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
            XCTAssertEqual(req.url?.path, "/office-members")
            return (200, Data(#"{"members":[{"slug":"human","name":"You"},{"slug":"cos","name":"Chief of Staff","built_in":true}],"meta":{"humanHasPosted":true}}"#.utf8))
        }
        let bots = try await makeClient().members()
        XCTAssertEqual(bots.map(\.slug), ["cos"])
        XCTAssertEqual(bots[0].dmChannel, "cos__human")
    }

    func testMembersToleratesANullRoster() async throws {
        StubURLProtocol.handler = { _ in (200, Data(#"{"channel":"general","members":null}"#.utf8)) }
        let bots = try await makeClient().members()
        XCTAssertEqual(bots, [])
    }

    func testMessagesQueryAndSendBody() async throws {
        StubURLProtocol.handler = { req in
            if req.httpMethod == "GET" {
                let q = URLComponents(url: req.url!, resolvingAgainstBaseURL: false)!.queryItems!
                XCTAssertTrue(q.contains(URLQueryItem(name: "channel", value: "cos__human")))
                XCTAssertTrue(q.contains(URLQueryItem(name: "viewer_slug", value: "human")))
                XCTAssertTrue(q.contains(URLQueryItem(name: "since_id", value: "m1")))
                return (200, Data(#"{"messages":[{"id":"m2","from":"cos","channel":"cos__human","content":"4.","timestamp":"2026-09-08T00:00:00Z"}]}"#.utf8))
            }
            let body = try! JSONSerialization.jsonObject(with: req.httpBody ?? req.streamBody()) as! [String: Any]
            XCTAssertEqual(body["from"] as? String, "you")
            XCTAssertEqual(body["channel"] as? String, "cos__human")
            XCTAssertEqual(body["content"] as? String, "hello")
            return (200, Data(#"{"id":"m3","from":"you","channel":"cos__human","content":"hello","timestamp":"2026-09-08T00:00:01Z"}"#.utf8))
        }
        let client = makeClient()
        let msgs = try await client.messages(channel: "cos__human", sinceID: "m1", limit: 50)
        XCTAssertEqual(msgs.map(\.id), ["m2"])
        let sent = try await client.send(channel: "cos__human", content: "hello")
        XCTAssertEqual(sent.id, "m3")
    }

    func testUnauthorizedIsTyped() async {
        StubURLProtocol.handler = { _ in (401, Data("{\"error\":\"unauthorized\"}".utf8)) }
        do {
            _ = try await makeClient().members()
            XCTFail("expected an error")
        } catch let e as BrokerError {
            XCTAssertEqual(e, .unauthorized)
        } catch {
            XCTFail("wrong error \(error)")
        }
    }
}

private extension URLRequest {
    /// URLProtocol hands POST bodies over as a stream; read it back.
    func streamBody() -> Data {
        guard let stream = httpBodyStream else { return Data() }
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
}
