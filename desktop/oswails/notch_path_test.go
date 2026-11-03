package main

import "testing"

func TestSafeAppPath(t *testing.T) {
	ok := map[string]string{
		"/inbox":                  "/inbox",
		"/channels/cos__human":    "/channels/cos__human",
		" /tasks/OFFICE-1?tab=x ": "/tasks/OFFICE-1?tab=x",
		"\t/x":                    "/x", // surrounding whitespace is trimmed, then validated
	}
	for in, want := range ok {
		got, valid := safeAppPath(in)
		if !valid || got != want {
			t.Errorf("safeAppPath(%q) = %q,%v want %q,true", in, got, valid, want)
		}
	}
	for _, bad := range []string{
		"", "inbox", "//evil.example/x", "https://evil.example", "javascript:alert(1)",
		"/\\evil.example", "/x\nSet-Cookie: a", "/a\tb",
	} {
		if got, valid := safeAppPath(bad); valid {
			t.Errorf("safeAppPath(%q) = %q, want rejected", bad, got)
		}
	}
}
