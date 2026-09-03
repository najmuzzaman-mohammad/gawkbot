package team

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
)

// TestAppRenamePatch locks in the rename contract: PATCH /apps/{id} with
// {"name":...} updates the manifest's Name + UpdatedAt in place (no version
// bump, no rebuild) and the new name is what every subsequent read returns —
// the FE's client-side rename store is a cache of this endpoint.
func TestAppRenamePatch(t *testing.T) {
	t.Setenv("WUPHF_RUNTIME_HOME", t.TempDir())

	b := newTestBroker(t)
	if err := b.StartOnPort(0); err != nil {
		t.Fatalf("start broker: %v", err)
	}
	defer b.Stop()
	base := fmt.Sprintf("http://%s", b.Addr())

	body, _ := json.Marshal(map[string]any{"name": "Old Name", "html": validAppHTML})
	created := postAppsAsBot(t, base+"/apps", b.Token(), appBuilderSlug, body)
	app, _ := created["app"].(map[string]any)
	id, _ := app["id"].(string)
	if id == "" {
		t.Fatalf("no app id in register response: %v", created)
	}
	prevUpdatedAt, _ := app["updatedAt"].(string)
	prevVersion, _ := app["version"].(float64)

	// Rename (name is trimmed) → 200 with the updated app.
	status, renamed := patchAppRename(t, base+"/apps/"+id, b.Token(), appBuilderSlug, `{"name":"  New Name  "}`)
	if status != http.StatusOK {
		t.Fatalf("rename status = %d, want 200: %v", status, renamed)
	}
	got, _ := renamed["app"].(map[string]any)
	if name, _ := got["name"].(string); name != "New Name" {
		t.Fatalf("renamed app name = %q, want %q", name, "New Name")
	}
	if at, _ := got["updatedAt"].(string); at == prevUpdatedAt || at == "" {
		t.Fatalf("rename did not stamp updatedAt (still %q)", at)
	}
	if v, _ := got["version"].(float64); v != prevVersion {
		t.Fatalf("rename bumped version %v -> %v; a rename is not a build", prevVersion, v)
	}

	// The rename is durable: a single-app fetch and the listing both reflect it.
	if _, cur := getAppsJSON(t, base+"/apps/"+id, b.Token()); cur != nil {
		curApp, _ := cur["app"].(map[string]any)
		if name, _ := curApp["name"].(string); name != "New Name" {
			t.Fatalf("GET /apps/{id} name = %q after rename, want %q", name, "New Name")
		}
	}
	_, listing := getAppsJSON(t, base+"/apps", b.Token())
	apps, _ := listing["apps"].([]any)
	found := false
	for _, raw := range apps {
		entry, _ := raw.(map[string]any)
		if entry["id"] == id {
			found = true
			if name, _ := entry["name"].(string); name != "New Name" {
				t.Fatalf("GET /apps listing name = %q after rename, want %q", name, "New Name")
			}
		}
	}
	if !found {
		t.Fatalf("renamed app %s missing from GET /apps listing", id)
	}
}

// TestAppRenameValidation covers the caller-error surface: empty/oversized
// names are 400s, an unknown (well-formed) id is a 404, and a malformed id is
// a 400 — all via the shared writeAppError mapping.
func TestAppRenameValidation(t *testing.T) {
	t.Setenv("WUPHF_RUNTIME_HOME", t.TempDir())

	b := newTestBroker(t)
	if err := b.StartOnPort(0); err != nil {
		t.Fatalf("start broker: %v", err)
	}
	defer b.Stop()
	base := fmt.Sprintf("http://%s", b.Addr())

	body, _ := json.Marshal(map[string]any{"name": "Keep Me", "html": validAppHTML})
	created := postAppsAsBot(t, base+"/apps", b.Token(), appBuilderSlug, body)
	app, _ := created["app"].(map[string]any)
	id, _ := app["id"].(string)
	if id == "" {
		t.Fatalf("no app id in register response: %v", created)
	}

	cases := []struct {
		name       string
		path       string
		body       string
		wantStatus int
	}{
		{"empty name", "/apps/" + id, `{"name":""}`, http.StatusBadRequest},
		{"whitespace name", "/apps/" + id, `{"name":"   "}`, http.StatusBadRequest},
		{"missing name field", "/apps/" + id, `{}`, http.StatusBadRequest},
		{"name over 120 bytes", "/apps/" + id, fmt.Sprintf(`{"name":%q}`, strings.Repeat("x", 121)), http.StatusBadRequest},
		{"invalid json", "/apps/" + id, `{`, http.StatusBadRequest},
		{"unknown id", "/apps/app_00000000000000aa", `{"name":"Ghost"}`, http.StatusNotFound},
		{"malformed id", "/apps/not-an-app-id", `{"name":"Ghost"}`, http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			status, resp := patchAppRename(t, base+tc.path, b.Token(), appBuilderSlug, tc.body)
			if status != tc.wantStatus {
				t.Fatalf("PATCH %s status = %d, want %d: %v", tc.path, status, tc.wantStatus, resp)
			}
		})
	}

	// None of the rejected renames touched the manifest.
	_, cur := getAppsJSON(t, base+"/apps/"+id, b.Token())
	curApp, _ := cur["app"].(map[string]any)
	if name, _ := curApp["name"].(string); name != "Keep Me" {
		t.Fatalf("app name = %q after rejected renames, want %q", name, "Keep Me")
	}
}

// TestAppRenameForbiddenForOtherBots mirrors the delete/rollback gate: a
// non-App-Builder bot holding the broker token must not rename apps.
func TestAppRenameForbiddenForOtherBots(t *testing.T) {
	t.Setenv("WUPHF_RUNTIME_HOME", t.TempDir())

	b := newTestBroker(t)
	if err := b.StartOnPort(0); err != nil {
		t.Fatalf("start broker: %v", err)
	}
	defer b.Stop()
	base := fmt.Sprintf("http://%s", b.Addr())

	body, _ := json.Marshal(map[string]any{"name": "Guarded", "html": validAppHTML})
	created := postAppsAsBot(t, base+"/apps", b.Token(), appBuilderSlug, body)
	app, _ := created["app"].(map[string]any)
	id, _ := app["id"].(string)
	if id == "" {
		t.Fatalf("no app id in register response: %v", created)
	}

	status, _ := patchAppRename(t, base+"/apps/"+id, b.Token(), "jim", `{"name":"Hijacked"}`)
	if status != http.StatusForbidden {
		t.Fatalf("rename as another bot status = %d, want 403", status)
	}
	_, cur := getAppsJSON(t, base+"/apps/"+id, b.Token())
	curApp, _ := cur["app"].(map[string]any)
	if name, _ := curApp["name"].(string); name != "Guarded" {
		t.Fatalf("app name = %q after forbidden rename, want %q", name, "Guarded")
	}
}

// TestAppRenameMethodNotAllowedOnSubpaths pins PATCH to the app root: subpaths
// with their own verb contracts reject it rather than silently renaming.
func TestAppRenameMethodNotAllowedOnSubpaths(t *testing.T) {
	t.Setenv("WUPHF_RUNTIME_HOME", t.TempDir())

	b := newTestBroker(t)
	if err := b.StartOnPort(0); err != nil {
		t.Fatalf("start broker: %v", err)
	}
	defer b.Stop()
	base := fmt.Sprintf("http://%s", b.Addr())

	body, _ := json.Marshal(map[string]any{"name": "Subpath", "html": validAppHTML})
	created := postAppsAsBot(t, base+"/apps", b.Token(), appBuilderSlug, body)
	app, _ := created["app"].(map[string]any)
	id, _ := app["id"].(string)
	if id == "" {
		t.Fatalf("no app id in register response: %v", created)
	}

	for _, sub := range []string{"/rollback", "/versions", "/edit-session", "/improve"} {
		status, _ := patchAppRename(t, base+"/apps/"+id+sub, b.Token(), appBuilderSlug, `{"name":"Nope"}`)
		if status != http.StatusMethodNotAllowed {
			t.Fatalf("PATCH /apps/{id}%s status = %d, want 405", sub, status)
		}
	}
}

func patchAppRename(t *testing.T, url, token, botSlug, body string) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPatch, url, bytes.NewReader([]byte(body)))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	if botSlug != "" {
		req.Header.Set("X-WUPHF-Agent", botSlug)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("PATCH %s: %v", url, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var out map[string]any
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &out)
	}
	return resp.StatusCode, out
}

// TestAppImproveOwnerToken locks in the OWNER lane on app mutations: the
// human owner authenticates with the bare web token and NO bot identity
// header (bots always claim a slug via X-WUPHF-Bot). Regression for the
// live 2026-07-06 finding where the operator UI's own submitAppEdit path
// 403'd — appWriterAllowed knew only the app-builder slug and cookie-session
// humans, so the single-owner localhost human could never improve an app.
//
// The channel both endpoints return is the app's own `app-<appid>` edit thread
// (see TestAppEditSessionLazilyMintsChannel). This test only cares that the
// owner lane reaches them at all, so it asserts a non-empty channel rather than
// its shape.
func TestAppImproveOwnerToken(t *testing.T) {
	t.Setenv("WUPHF_RUNTIME_HOME", t.TempDir())

	b := newTestBroker(t)
	if err := b.StartOnPort(0); err != nil {
		t.Fatalf("start broker: %v", err)
	}
	defer b.Stop()
	base := fmt.Sprintf("http://%s", b.Addr())

	body, _ := json.Marshal(map[string]any{"name": "Editable", "html": validAppHTML})
	created := postAppsAsBot(t, base+"/apps", b.Token(), appBuilderSlug, body)
	app, _ := created["app"].(map[string]any)
	id, _ := app["id"].(string)
	if id == "" {
		t.Fatalf("no app id in register response: %v", created)
	}

	post := func(sub, botSlug, payload string) (int, map[string]any) {
		req, _ := http.NewRequest(http.MethodPost, base+"/apps/"+id+sub, strings.NewReader(payload))
		req.Header.Set("Authorization", "Bearer "+b.Token())
		req.Header.Set("Content-Type", "application/json")
		if botSlug != "" {
			req.Header.Set("X-WUPHF-Agent", botSlug)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("POST %s: %v", sub, err)
		}
		defer resp.Body.Close()
		raw, _ := io.ReadAll(resp.Body)
		var out map[string]any
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &out)
		}
		return resp.StatusCode, out
	}

	// The owner (token, no bot header) may improve; the reply carries the
	// settled edit channel.
	status, out := post("/improve", "", `{"change":"make the header sticky"}`)
	if status != http.StatusOK {
		t.Fatalf("owner POST /improve status = %d (%v), want 200", status, out)
	}
	if ch, _ := out["channel"].(string); strings.TrimSpace(ch) == "" {
		t.Fatalf("owner improve returned no channel: %v", out)
	}

	// Same for opening the edit session directly.
	status, out = post("/edit-session", "", `{}`)
	if status != http.StatusOK {
		t.Fatalf("owner POST /edit-session status = %d (%v), want 200", status, out)
	}

	// A non-app-builder BOT identity stays rejected.
	status, _ = post("/improve", "pam", `{"change":"nope"}`)
	if status != http.StatusForbidden {
		t.Fatalf("bot POST /improve status = %d, want 403", status)
	}
}
