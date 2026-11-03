package team

// notch_app_hints.go: which integration the app or page in front of the
// owner belongs to, so the notch can offer to connect it, once and quietly
// (broker_notch_hint.go). Only platforms the curated catalog offers, and
// only first-party apps and domains: a browser's own bundle id never maps,
// the page it shows does. The table is static on purpose; what it costs
// is one map lookup per poll, and what it never does is guess.

import (
	"strings"

	"github.com/nex-crm/wuphf/internal/action"
)

// notchHintDomains maps a page's host, or any parent of it, to a platform.
var notchHintDomains = map[string]string{
	"mail.google.com":     "gmail",
	"calendar.google.com": "googlecalendar",
	"drive.google.com":    "googledrive",
	"docs.google.com":     "googledrive",
	"sheets.google.com":   "googledrive",
	"slides.google.com":   "googledrive",
	"github.com":          "github",
	"linear.app":          "linear",
	"notion.so":           "notion",
	"notion.site":         "notion",
	"atlassian.net":       "jira",
	"hubspot.com":         "hubspot",
	"salesforce.com":      "salesforce",
	"force.com":           "salesforce",
	"slack.com":           "slack",
}

// notchHintBundles maps a first-party Mac app to its platform.
var notchHintBundles = map[string]string{
	"com.github.GitHubClient":   "github",
	"notion.id":                 "notion",
	"com.tinyspeck.slackmacgap": "slack",
}

// notchHintWhy says, per platform, what connecting it is for.
var notchHintWhy = map[string]string{
	"gmail":          "so your bots can read this inbox",
	"googlecalendar": "so your bots can see this calendar",
	"googledrive":    "so your bots can read these files",
	"github":         "so your bots can read these pull requests",
	"linear":         "so your bots can work these issues",
	"notion":         "so your bots can read these pages",
	"jira":           "so your bots can work these issues",
	"hubspot":        "so your bots can read these records",
	"salesforce":     "so your bots can read these records",
	"slack":          "so your bots can read these channels",
}

// notchHintPlatformFor names the platform behind what is in front, or "".
func notchHintPlatformFor(screen *notchScreen) string {
	if screen == nil {
		return ""
	}
	if p, ok := notchHintBundles[strings.TrimSpace(screen.BundleID)]; ok {
		return p
	}
	domain := strings.TrimPrefix(strings.ToLower(strings.TrimSpace(screen.Domain)), "www.")
	for domain != "" {
		if p, ok := notchHintDomains[domain]; ok {
			return p
		}
		dot := strings.Index(domain, ".")
		if dot < 0 {
			break
		}
		domain = domain[dot+1:]
	}
	return ""
}

// notchHintToolkit finds the curated entry for a platform.
func notchHintToolkit(platform string) (curatedComposioToolkit, bool) {
	for _, t := range curatedComposioToolkits {
		if t.platform == platform {
			return t, true
		}
	}
	return curatedComposioToolkit{}, false
}

// notchHintLine is the one sentence the notch says.
func notchHintLine(platform string) string {
	name := action.DisplayPlatformName(platform)
	if t, ok := notchHintToolkit(platform); ok && strings.TrimSpace(t.name) != "" {
		name = t.name
	}
	why := notchHintWhy[platform]
	if why == "" {
		why = "so your bots can use it"
	}
	return "Connect " + name + " " + why
}
