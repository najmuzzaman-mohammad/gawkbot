package main

import (
	"net/url"
	"strings"
)

// safeAppPath accepts only an in-app path ("/channels/x", "/inbox") so a
// message from the notch page can never navigate the main window off the
// office origin (no "//host", no scheme, no "javascript:"). Untagged so it is
// unit-tested in plain `go test`.
func safeAppPath(raw string) (string, bool) {
	p := strings.TrimSpace(raw)
	if p == "" || !strings.HasPrefix(p, "/") || strings.HasPrefix(p, "//") || strings.ContainsAny(p, "\\\r\n\t") {
		return "", false
	}
	u, err := url.Parse(p)
	if err != nil || u.Scheme != "" || u.Host != "" || u.User != nil {
		return "", false
	}
	return u.RequestURI(), true
}
