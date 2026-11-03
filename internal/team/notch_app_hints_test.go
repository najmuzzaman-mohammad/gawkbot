package team

import (
	"strings"
	"testing"
)

func TestNotchHintPlatformForMapsPagesAndFirstPartyAppsOnly(t *testing.T) {
	cases := []struct {
		screen notchScreen
		want   string
	}{
		{notchScreen{App: "Chrome", BundleID: "com.google.Chrome", Domain: "mail.google.com"}, "gmail"},
		{notchScreen{App: "Safari", BundleID: "com.apple.Safari", Domain: "www.github.com"}, "github"},
		{notchScreen{App: "Arc", Domain: "acme.atlassian.net"}, "jira"},
		{notchScreen{App: "Arc", Domain: "lightning.force.com"}, "salesforce"},
		{notchScreen{App: "Arc", Domain: "app.hubspot.com"}, "hubspot"},
		{notchScreen{App: "Chrome", BundleID: "com.google.Chrome", Domain: "google.com"}, ""},
		{notchScreen{App: "Chrome", BundleID: "com.google.Chrome"}, ""},
		{notchScreen{App: "Slack", BundleID: "com.tinyspeck.slackmacgap"}, "slack"},
		{notchScreen{App: "Finder", BundleID: "com.apple.finder"}, ""},
	}
	for _, c := range cases {
		if got := notchHintPlatformFor(&c.screen); got != c.want {
			t.Errorf("%+v: got %q, want %q", c.screen, got, c.want)
		}
	}
	if notchHintPlatformFor(nil) != "" {
		t.Fatal("nothing in front mapped to a platform")
	}
}

func TestNotchHintTablesNameOnlyCuratedPlatforms(t *testing.T) {
	curated := map[string]bool{}
	for _, tk := range curatedComposioToolkits {
		curated[tk.platform] = true
	}
	for domain, p := range notchHintDomains {
		if !curated[p] {
			t.Errorf("%s maps to %q, which the catalog does not offer", domain, p)
		}
		if _, ok := notchHintWhy[p]; !ok {
			t.Errorf("%s has no line", p)
		}
	}
	for bundle, p := range notchHintBundles {
		if !curated[p] {
			t.Errorf("%s maps to %q, which the catalog does not offer", bundle, p)
		}
		if strings.Contains(strings.ToLower(bundle), "chrome") || strings.Contains(strings.ToLower(bundle), "safari") || strings.Contains(strings.ToLower(bundle), "firefox") || strings.Contains(strings.ToLower(bundle), "arc") {
			t.Errorf("a browser's own bundle id maps: %s", bundle)
		}
	}
	if line := notchHintLine("gmail"); line != "Connect Gmail so your bots can read this inbox" {
		t.Fatalf("line: %q", line)
	}
}
