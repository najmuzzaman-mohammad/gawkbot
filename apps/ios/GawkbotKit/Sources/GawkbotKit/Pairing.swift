import Foundation

/// How a phone joins an office: the web UI's Access & Health card shows a QR
/// code carrying `gawkbot://pair?url=<broker>&token=<token>`. The same fields
/// can be typed by hand.
public struct Pairing: Equatable, Sendable {
    public var brokerURL: URL
    public var token: String

    public init(brokerURL: URL, token: String) {
        self.brokerURL = brokerURL
        self.token = token
    }

    public static let scheme = "gawkbot"

    /// Parses a pairing link. Accepts `gawkbot://pair?url=…&token=…` and a
    /// bare `https://host:port?token=…` (what someone pastes from a browser).
    public static func parse(_ text: String) -> Pairing? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let comps = URLComponents(string: trimmed) else { return nil }
        let items = comps.queryItems ?? []
        func item(_ name: String) -> String? {
            items.first { $0.name == name }?.value?.trimmingCharacters(in: .whitespaces)
        }
        if comps.scheme == scheme {
            guard comps.host == "pair", let raw = item("url"), let token = item("token"), !token.isEmpty else { return nil }
            return make(urlString: raw, token: token)
        }
        if comps.scheme == "http" || comps.scheme == "https", let token = item("token"), !token.isEmpty {
            var bare = comps
            bare.queryItems = nil
            guard let url = bare.url else { return nil }
            return make(urlString: url.absoluteString, token: token)
        }
        return nil
    }

    /// Validates a hand-typed address + token.
    public static func make(urlString: String, token: String) -> Pairing? {
        var raw = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        if !raw.contains("://") { raw = "http://" + raw }
        while raw.hasSuffix("/") { raw.removeLast() }
        guard let url = URL(string: raw), let scheme = url.scheme, ["http", "https"].contains(scheme), url.host != nil else { return nil }
        let tok = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !tok.isEmpty else { return nil }
        return Pairing(brokerURL: url, token: tok)
    }

    /// The link the web UI encodes into its QR code.
    public var link: String {
        var comps = URLComponents()
        comps.scheme = Pairing.scheme
        comps.host = "pair"
        comps.queryItems = [URLQueryItem(name: "url", value: brokerURL.absoluteString), URLQueryItem(name: "token", value: token)]
        return comps.url?.absoluteString ?? ""
    }
}

/// Where the pairing lives between launches. The app uses the Keychain-backed
/// store; tests use the in-memory one.
public protocol CredentialStore: AnyObject, Sendable {
    func load() -> Pairing?
    func save(_ pairing: Pairing)
    func clear()
}

public final class MemoryCredentialStore: CredentialStore, @unchecked Sendable {
    private var pairing: Pairing?
    private let lock = NSLock()
    public init(_ initial: Pairing? = nil) { pairing = initial }
    public func load() -> Pairing? { lock.withLock { pairing } }
    public func save(_ p: Pairing) { lock.withLock { pairing = p } }
    public func clear() { lock.withLock { pairing = nil } }
}
