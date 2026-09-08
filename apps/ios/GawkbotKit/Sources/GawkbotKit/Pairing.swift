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

    /// Validates a hand-typed address + token. Cleartext `http://` is
    /// accepted only for hosts on a private network (see `isPrivateHost`);
    /// a public host must use `https://`, so the token is never sent in the
    /// clear across the internet.
    public static func make(urlString: String, token: String) -> Pairing? {
        var raw = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        if !raw.contains("://") { raw = "http://" + raw }
        while raw.hasSuffix("/") { raw.removeLast() }
        guard let url = URL(string: raw), let scheme = url.scheme, ["http", "https"].contains(scheme), let host = url.host else { return nil }
        if scheme == "http" && !isPrivateHost(host) { return nil }
        let tok = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !tok.isEmpty else { return nil }
        return Pairing(brokerURL: url, token: tok)
    }

    /// Hosts an office is reached at over a LAN, a VPN, or this machine:
    /// loopback, RFC 1918 ranges, link-local, Tailscale's 100.64/10, `.local`,
    /// `.ts.net`, and bare single-label names. Everything else is public.
    public static func isPrivateHost(_ rawHost: String) -> Bool {
        let host = rawHost.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if host == "localhost" || host == "::1" { return true }
        if host.hasSuffix(".local") || host.hasSuffix(".ts.net") || host.hasSuffix(".internal") { return true }
        if !host.contains(".") && !host.contains(":") { return true }
        let parts = host.split(separator: ".").compactMap { Int($0) }
        guard parts.count == 4, parts.allSatisfy({ (0...255).contains($0) }) else { return false }
        switch (parts[0], parts[1]) {
        case (10, _), (127, _): return true
        case (192, 168): return true
        case (169, 254): return true
        case (172, let b) where (16...31).contains(b): return true
        case (100, let b) where (64...127).contains(b): return true
        default: return false
        }
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
