import Foundation
import Security
import GawkbotKit

/// The broker token is a full-access credential, so it lives in the
/// Keychain; the broker URL is not secret and lives in UserDefaults.
final class KeychainCredentialStore: CredentialStore, @unchecked Sendable {
    private let service = "bot.gawk.ios.broker-token"
    private let account = "default"
    private let urlKey = "gawkbot.brokerURL"

    func load() -> Pairing? {
        guard let raw = UserDefaults.standard.string(forKey: urlKey), let url = URL(string: raw), let token = readToken() else { return nil }
        return Pairing(brokerURL: url, token: token)
    }

    func save(_ pairing: Pairing) {
        UserDefaults.standard.set(pairing.brokerURL.absoluteString, forKey: urlKey)
        writeToken(pairing.token)
    }

    func clear() {
        UserDefaults.standard.removeObject(forKey: urlKey)
        SecItemDelete(baseQuery() as CFDictionary)
    }

    private func baseQuery() -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    private func readToken() -> String? {
        var q = baseQuery()
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func writeToken(_ token: String) {
        let data = Data(token.utf8)
        var q = baseQuery()
        SecItemDelete(q as CFDictionary)
        q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(q as CFDictionary, nil)
    }
}
