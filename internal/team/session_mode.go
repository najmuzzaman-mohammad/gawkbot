package team

import "strings"

const (
	SessionModeOffice   = "office"
	SessionModeOneOnOne = "1o1"

	DefaultOneOnOneBot = "ceo"
)

func NormalizeSessionMode(mode string) string {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case SessionModeOneOnOne, "1:1", "one-on-one", "one_on_one", "1on1", "solo":
		return SessionModeOneOnOne
	default:
		return SessionModeOffice
	}
}

func NormalizeOneOnOneBot(slug string) string {
	slug = strings.ToLower(strings.TrimSpace(slug))
	slug = strings.ReplaceAll(slug, " ", "-")
	slug = strings.ReplaceAll(slug, "_", "-")
	if slug == "" {
		return DefaultOneOnOneBot
	}
	return slug
}
