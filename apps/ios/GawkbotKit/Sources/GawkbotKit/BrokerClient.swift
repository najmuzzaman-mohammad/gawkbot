import Foundation

/// The real broker. Bearer token in the Authorization header on every
/// request, the `/events` stream included: URLSession can set headers on a
/// streaming GET, so the token never appears in a URL (logs, proxies).
public final class BrokerClient: BrokerAPI, @unchecked Sendable {
    public let baseURL: URL
    private let token: String
    private let session: URLSession

    public init(baseURL: URL, token: String, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
    }

    // MARK: - BrokerAPI

    public func members() async throws -> [Bot] {
        struct Envelope: Decodable { let members: [Bot] }
        let env: Envelope = try await get("/members", query: [:])
        return env.members.filter { !Human.isHuman($0.slug) }
    }

    public func messages(channel: String, sinceID: String?, limit: Int) async throws -> [ChatMessage] {
        struct Envelope: Decodable { let messages: [ChatMessage] }
        var query = ["channel": channel, "viewer_slug": Human.slug, "limit": String(limit)]
        if let sinceID, !sinceID.isEmpty { query["since_id"] = sinceID }
        let env: Envelope = try await get("/messages", query: query)
        return env.messages
    }

    @discardableResult
    public func send(channel: String, content: String) async throws -> ChatMessage {
        try await post("/messages", body: ["from": "you", "channel": channel, "content": content])
    }

    public func requests(channel: String?) async throws -> [BotRequest] {
        struct Envelope: Decodable { let requests: [BotRequest] }
        var query = ["viewer_slug": Human.slug]
        if let channel, !channel.isEmpty { query["channel"] = channel }
        let env: Envelope = try await get("/requests", query: query)
        return env.requests
    }

    public func answer(requestID: String, choiceID: String, text: String?) async throws {
        var body: [String: Any] = ["id": requestID, "choice_id": choiceID]
        if let text, !text.isEmpty { body["custom_text"] = text }
        struct OK: Decodable { let ok: Bool? }
        let _: OK = try await post("/requests/answer", body: body)
    }

    public func events() -> AsyncStream<BrokerEvent> {
        AsyncStream { continuation in
            let task = Task {
                defer { continuation.finish() }
                var req = URLRequest(url: baseURL.appendingPathComponent("events"))
                req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                req.timeoutInterval = 60 * 60
                do {
                    let (bytes, response) = try await session.bytes(for: req)
                    guard (response as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) ?? false else { return }
                    var parser = SSEParser()
                    for try await line in bytes.lines {
                        if Task.isCancelled { return }
                        if let raw = parser.feed(line: line), let event = BrokerEventDecoder.decode(raw) {
                            continuation.yield(event)
                        }
                    }
                } catch {
                    // Connection dropped; the caller reconnects.
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    // MARK: - Transport

    private func get<T: Decodable>(_ path: String, query: [String: String]) async throws -> T {
        var comps = URLComponents(url: baseURL.appendingPathComponent(path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))), resolvingAgainstBaseURL: false)
        if !query.isEmpty {
            comps?.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        guard let url = comps?.url else { throw BrokerError.badURL }
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        authorize(&req)
        return try await perform(req, what: path)
    }

    private func post<T: Decodable>(_ path: String, body: [String: Any]) async throws -> T {
        let url = baseURL.appendingPathComponent(path.trimmingCharacters(in: CharacterSet(charactersIn: "/")))
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        authorize(&req)
        return try await perform(req, what: path)
    }

    private func authorize(_ req: inout URLRequest) {
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
    }

    private func perform<T: Decodable>(_ req: URLRequest, what: String) async throws -> T {
        let (data, response) = try await session.data(for: req)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        if code == 401 || code == 403 { throw BrokerError.unauthorized }
        guard (200..<300).contains(code) else {
            throw BrokerError.http(code, String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "")
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw BrokerError.decoding(what)
        }
    }
}
