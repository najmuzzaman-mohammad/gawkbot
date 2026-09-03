package team

// mcp_namespace.go owns the MCP server KEY that bots' tools are namespaced under,
// and the older keys that must keep working forever.
//
// WHY THIS IS AN ALIAS AND NEVER A RENAME.
//
// The server key is not an internal detail. Clients derive every tool name from
// it — a key of "wuphf-office" makes the tools "mcp__wuphf-office__team_task"
// and so on — and those fully-qualified strings end up written down in places
// we do not own and cannot edit:
//
//   - users' tool-permission allowlists, where a granted permission is stored
//     by exact tool name
//   - saved skills and prompt files that name specific tools
//   - bot transcripts and replay fixtures
//
// Renaming the key silently REVOKES every one of those grants. The permission
// simply no longer matches, the tool is refused or invisible, and nothing in
// the error names the rename as the cause. It is unfixable remotely, because
// the stale strings live on the user's disk.
//
// So the new key is added and the old one is KEPT REGISTERED INDEFINITELY. The
// cost of an alias is one entry in a map. The cost of a rename is a support
// burden nobody can debug from here. There is no deprecation date on this list
// on purpose: unlike an environment variable, we have no way to warn the holder
// of a stale allowlist, so it does not expire.
// It lives in package team, NOT in package teammcp where it was written,
// because teammcp already imports team — so team importing teammcp back is a
// cycle, and the wiring that has to consult these keys (buildMCPServerMap,
// botMCPServers, the headless opencode entry) all lives here. The file has
// no imports of its own, so moving it costs nothing; teammcp can still reach
// these symbols through its existing dependency on team if it ever needs to.
const (
	// ServerKey is the canonical MCP server key. Tools are exposed to clients
	// as mcp__<ServerKey>__<tool>.
	//
	// Note this is the SERVER KEY, not the name reported in the MCP handshake.
	// The handshake name is left alone deliberately: it is one of the persisted
	// identifiers this rename does not touch.
	ServerKey = "wuphf-office"
)

// LegacyServerKeys are server keys this runtime used to publish under. Every
// one stays registered so tool permissions granted against it keep matching.
//
// When the rename lands: set ServerKey to the new key and PREPEND the old key
// here. Never remove an entry.
var LegacyServerKeys = []string{}

// ServerKeys returns every key the office server must be registered under,
// canonical first. Callers building an MCP client config should register the
// same server entry under each of these.
func ServerKeys() []string {
	keys := make([]string, 0, 1+len(LegacyServerKeys))
	keys = append(keys, ServerKey)
	seen := map[string]bool{ServerKey: true}
	for _, k := range LegacyServerKeys {
		if k == "" || seen[k] {
			continue
		}
		seen[k] = true
		keys = append(keys, k)
	}
	return keys
}

// QualifiedToolName renders the client-visible name for a tool under the
// canonical key, e.g. "team_task" -> "mcp__wuphf-office__team_task".
func QualifiedToolName(tool string) string {
	return "mcp__" + ServerKey + "__" + tool
}

// AcceptsQualifiedToolName reports whether a fully-qualified tool name refers
// to this server under the canonical key OR any legacy key. Use it when
// matching a name that may have been written down before a rename.
func AcceptsQualifiedToolName(qualified string) bool {
	for _, key := range ServerKeys() {
		prefix := "mcp__" + key + "__"
		if len(qualified) > len(prefix) && qualified[:len(prefix)] == prefix {
			return true
		}
	}
	return false
}
