import Foundation

/// One event off the broker's `/events` stream. Only the two the chat needs
/// are typed; everything else is passed through by name so callers can
/// ignore it without the parser having to know the whole catalogue.
public enum BrokerEvent: Sendable, Equatable {
    case message(ChatMessage)
    case activity(BotActivity)
    case ready
    case other(name: String)
}

/// Everything the app needs from an office. `BrokerClient` talks to a real
/// broker; `MockBroker` plays one for previews, screenshots, and tests.
public protocol BrokerAPI: Sendable {
    func members() async throws -> [Bot]
    func messages(channel: String, sinceID: String?, limit: Int) async throws -> [ChatMessage]
    @discardableResult
    func send(channel: String, content: String) async throws -> ChatMessage
    func requests(channel: String?) async throws -> [BotRequest]
    func answer(requestID: String, choiceID: String, text: String?) async throws
    /// A long-lived stream of live events. Finishes when the connection drops;
    /// callers reconnect.
    func events() -> AsyncStream<BrokerEvent>
}

public enum BrokerError: Error, LocalizedError, Equatable {
    case unauthorized
    case http(Int, String)
    case badURL
    case decoding(String)

    public var errorDescription: String? {
        switch self {
        case .unauthorized: return "The office rejected the token. Pair again from Access & Health."
        case let .http(code, body): return "The office answered \(code)\(body.isEmpty ? "" : ": \(body)")"
        case .badURL: return "That is not a valid office address."
        case let .decoding(what): return "Could not read \(what) from the office."
        }
    }
}
