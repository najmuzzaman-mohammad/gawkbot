package team

import "strings"

// librarian.go holds what remains of the Librarian, a bot RETIRED as a
// default. New workspaces do not seed it and nothing back-fills it; wiki
// contribution is a system skill every bot carries instead. The slug
// helpers and name constants stay because legacy workspaces still hold the
// member on disk — it loads as an ordinary, removable bot, and load-time
// reconciliation rebrands its display name away from the old Office
// reference.

// LibrarianSlug is the roster slug for the Librarian bot.
const LibrarianSlug = "librarian"

const (
	// "Librarian", not "Pam the librarian": the Office reference is banned from
	// the product ("no :the office"), and load-time reconciliation forces this
	// name onto legacy rosters, so changing the constant here rebrands every
	// existing workspace on its next boot.
	librarianName = "Librarian"
	librarianRole = "Librarian"
)

// isLibrarianSlug reports whether slug is the Librarian (case-insensitive).
func isLibrarianSlug(slug string) bool {
	return strings.EqualFold(strings.TrimSpace(slug), LibrarianSlug)
}
