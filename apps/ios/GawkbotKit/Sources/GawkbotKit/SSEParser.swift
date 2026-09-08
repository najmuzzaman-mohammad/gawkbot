import Foundation

/// Incremental server-sent-events parser. Feed it lines; it emits an event
/// at each blank line. `event:` defaults to "message" per the spec, which is
/// also the broker's chat-message event name.
public struct SSEParser: Sendable {
    public struct Event: Equatable, Sendable {
        public var name: String
        public var data: String
        public init(name: String, data: String) {
            self.name = name
            self.data = data
        }
    }

    private var name = ""
    private var dataLines: [String] = []

    public init() {}

    /// Returns the completed event when `line` closes one.
    public mutating func feed(line rawLine: String) -> Event? {
        let line = rawLine.hasSuffix("\r") ? String(rawLine.dropLast()) : rawLine
        if line.isEmpty {
            defer { name = ""; dataLines = [] }
            guard !dataLines.isEmpty || !name.isEmpty else { return nil }
            return Event(name: name.isEmpty ? "message" : name, data: dataLines.joined(separator: "\n"))
        }
        if line.hasPrefix(":") { return nil } // comment / keepalive
        let (field, value) = split(line)
        switch field {
        case "event": name = value
        case "data": dataLines.append(value)
        default: break // id, retry: unused
        }
        return nil
    }

    private func split(_ line: String) -> (String, String) {
        guard let colon = line.firstIndex(of: ":") else { return (line, "") }
        let field = String(line[..<colon])
        var value = String(line[line.index(after: colon)...])
        if value.hasPrefix(" ") { value.removeFirst() }
        return (field, value)
    }
}

/// Turns a raw SSE event into a typed broker event. Unknown names pass
/// through; malformed payloads for known names are dropped (nil).
public enum BrokerEventDecoder {
    public static func decode(_ event: SSEParser.Event) -> BrokerEvent? {
        let decoder = JSONDecoder()
        switch event.name {
        case "message":
            guard let data = event.data.data(using: .utf8),
                  let msg = try? decoder.decode(ChatMessage.self, from: data) else { return nil }
            return .message(msg)
        case "activity":
            guard let data = event.data.data(using: .utf8),
                  let act = try? decoder.decode(BotActivity.self, from: data) else { return nil }
            return .activity(act)
        case "ready":
            return .ready
        default:
            return .other(name: event.name)
        }
    }
}
