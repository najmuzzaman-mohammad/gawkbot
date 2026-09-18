package team

// broker_apps_data_test.go covers /apps/{id}/data-space: the binding between a
// built App and a data space. It reuses the fake store + harness from
// broker_data_test.go (same package) so a ForbiddenError can be produced
// without first building the state that would earn one, and drives everything
// over a real listener the way broker_apps_integration_test.go does.

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nex-crm/wuphf/internal/dataspace"
)

const testAppID = "app_0123456789abcdef"

// A second well-formed space id, so "attach elsewhere" is a real id and not a
// shape the dispatcher would reject for the wrong reason.
const testSpaceAltID = "space_fedcba9876543210"

// seedTestApp materializes a real app on disk so the manifest reads/writes
// under test hit the same store the broker uses.
func seedTestApp(t *testing.T, b *Broker) CustomApp {
	t.Helper()
	app, err := b.appStore().Scaffold(testAppID, "Pipeline board", "📊", "cos", time.Now())
	if err != nil {
		t.Fatalf("scaffold app: %v", err)
	}
	return app
}

// readAppManifest reads app.json straight off disk — the round-trip assertion,
// not the in-memory value the handler happened to return.
func readAppManifest(t *testing.T, b *Broker, id string) CustomApp {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(b.appStore().appDir(id), customAppManifestFile))
	if err != nil {
		t.Fatalf("read manifest: %v", err)
	}
	var app CustomApp
	if err := json.Unmarshal(raw, &app); err != nil {
		t.Fatalf("decode manifest: %v", err)
	}
	return app
}

func appDataSpaceURL(base, id string) string { return base + "/apps/" + id + "/data-space" }

// TestAppDataSpaceAttachDetach is the happy path: attach writes BOTH halves
// (the manifest and the space's AttachedAppIDs), GET reads the binding back,
// and detach clears both.
func TestAppDataSpaceAttachDetach(t *testing.T) {
	b, fake, base := startDataBroker(t)
	seedTestApp(t, b)
	url := appDataSpaceURL(base, testAppID)

	status, body := dataRequest(t, http.MethodGet, url, b, "", nil)
	if status != http.StatusOK {
		t.Fatalf("GET data-space -> %d: %v", status, body)
	}
	if got, _ := body["space_id"].(string); got != "" {
		t.Fatalf("a fresh app must have no data space, got %q", got)
	}

	status, body = dataRequest(t, http.MethodPost, url, b, "cos",
		map[string]any{"space_id": testSpaceID})
	if status != http.StatusOK {
		t.Fatalf("attach -> %d: %v", status, body)
	}
	app, _ := body["app"].(map[string]any)
	if got, _ := app["data_space"].(string); got != testSpaceID {
		t.Fatalf("app payload data_space = %q, want %q (payload: %v)", got, testSpaceID, body)
	}
	if !calledOnce(fake.callNames(), "AttachApp") {
		t.Fatalf("attach must reach the store's AttachApp; calls=%v", fake.callNames())
	}
	if actor := fake.actor(); actor != dataspace.Actor("cos") {
		t.Fatalf("store actor = %q, want the calling bot slug", actor)
	}

	status, body = dataRequest(t, http.MethodGet, url, b, "", nil)
	if status != http.StatusOK || body["space_id"] != testSpaceID {
		t.Fatalf("GET after attach -> %d: %v", status, body)
	}

	status, body = dataRequest(t, http.MethodDelete, url, b, "cos", nil)
	if status != http.StatusOK {
		t.Fatalf("detach -> %d: %v", status, body)
	}
	if !calledOnce(fake.callNames(), "DetachApp") {
		t.Fatalf("detach must reach the store's DetachApp; calls=%v", fake.callNames())
	}
	if got := readAppManifest(t, b, testAppID).DataSpace; got != "" {
		t.Fatalf("manifest data space after detach = %q, want empty", got)
	}
}

// TestAppDataSpaceManifestRoundTrip pins the on-disk shape: the binding
// survives as `data_space` in app.json, and every other manifest field the app
// already carried is still there.
func TestAppDataSpaceManifestRoundTrip(t *testing.T) {
	b, _, base := startDataBroker(t)
	seeded := seedTestApp(t, b)

	status, body := dataRequest(t, http.MethodPost, appDataSpaceURL(base, testAppID),
		b, "", map[string]any{"space_id": testSpaceAltID})
	if status != http.StatusOK {
		t.Fatalf("attach -> %d: %v", status, body)
	}
	on := readAppManifest(t, b, testAppID)
	if on.DataSpace != testSpaceAltID {
		t.Fatalf("app.json data_space = %q, want %q", on.DataSpace, testSpaceAltID)
	}
	if on.Name != seeded.Name || on.Slug != seeded.Slug || on.Status != seeded.Status {
		t.Fatalf("attaching a space rewrote unrelated manifest fields: %+v vs %+v", on, seeded)
	}

	// The zero value is migration-safe: a manifest written before this field
	// existed has no `data_space` key at all, and reads back as "".
	raw, err := json.Marshal(CustomApp{ID: testAppID, Name: "Legacy"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(raw), "data_space") {
		t.Fatalf("an unattached app must not emit data_space: %s", raw)
	}
	var legacy CustomApp
	if err := json.Unmarshal([]byte(`{"id":"app_0123456789abcdef","name":"Legacy"}`), &legacy); err != nil {
		t.Fatalf("unmarshal legacy manifest: %v", err)
	}
	if legacy.DataSpace != "" {
		t.Fatalf("legacy manifest data space = %q, want empty", legacy.DataSpace)
	}
}

// TestAppDataSpaceAttachRequiresWriteAccess is the authorization test: a bot
// that can only READ the space cannot bind an app to it, and the refusal
// leaves the manifest untouched.
func TestAppDataSpaceAttachRequiresWriteAccess(t *testing.T) {
	b, fake, base := startDataBroker(t)
	seedTestApp(t, b)
	fake.err = &dataspace.ForbiddenError{SpaceID: testSpaceID, Owner: "cos"}

	status, body := dataRequest(t, http.MethodPost, appDataSpaceURL(base, testAppID),
		b, "ops", map[string]any{"space_id": testSpaceID})
	if status != http.StatusForbidden {
		t.Fatalf("read-only attach -> %d, want 403: %v", status, body)
	}
	if got := readAppManifest(t, b, testAppID).DataSpace; got != "" {
		t.Fatalf("a refused attach must not write the manifest, got %q", got)
	}
}

// TestAppDataSpaceAttachHidesUnseeableSpace: a space the caller cannot see is
// a 404, not a 403 — probing for another bot's private spaces through the app
// route must be no easier than through /data.
func TestAppDataSpaceAttachHidesUnseeableSpace(t *testing.T) {
	b, fake, base := startDataBroker(t)
	seedTestApp(t, b)
	fake.err = dataspace.ErrNotFound

	status, body := dataRequest(t, http.MethodPost, appDataSpaceURL(base, testAppID),
		b, "ops", map[string]any{"space_id": testSpaceAltID})
	if status != http.StatusNotFound {
		t.Fatalf("invisible space attach -> %d, want 404: %v", status, body)
	}
	if got := readAppManifest(t, b, testAppID).DataSpace; got != "" {
		t.Fatalf("a refused attach must not write the manifest, got %q", got)
	}
}

// TestAppPayloadCarriesDataSpace: the FE reads the binding off the app payload
// it already fetches, so GET /apps/{id} and GET /apps must both carry it.
func TestAppPayloadCarriesDataSpace(t *testing.T) {
	b, _, base := startDataBroker(t)
	seedTestApp(t, b)

	if status, body := dataRequest(t, http.MethodPost, appDataSpaceURL(base, testAppID),
		b, "", map[string]any{"space_id": testSpaceID}); status != http.StatusOK {
		t.Fatalf("attach -> %d: %v", status, body)
	}

	status, body := dataRequest(t, http.MethodGet, base+"/apps/"+testAppID, b, "", nil)
	if status != http.StatusOK {
		t.Fatalf("GET app -> %d: %v", status, body)
	}
	app, _ := body["app"].(map[string]any)
	if got, _ := app["data_space"].(string); got != testSpaceID {
		t.Fatalf("GET /apps/{id} app.data_space = %q, want %q", got, testSpaceID)
	}

	status, body = dataRequest(t, http.MethodGet, base+"/apps", b, "", nil)
	if status != http.StatusOK {
		t.Fatalf("GET apps -> %d: %v", status, body)
	}
	apps, _ := body["apps"].([]any)
	if len(apps) == 0 {
		t.Fatalf("expected the seeded app in the listing: %v", body)
	}
	listed, _ := apps[0].(map[string]any)
	if got, _ := listed["data_space"].(string); got != testSpaceID {
		t.Fatalf("GET /apps app.data_space = %q, want %q", got, testSpaceID)
	}
}

// TestAppDataSpaceRejectsBadInput covers the cheap gates: an unknown app is a
// 404, a missing space_id is a 400, and a detach with nothing attached is an
// idempotent 200 that never touches the data store.
func TestAppDataSpaceRejectsBadInput(t *testing.T) {
	b, fake, base := startDataBroker(t)
	seedTestApp(t, b)

	unknown := appDataSpaceURL(base, "app_fedcba9876543210")
	if status, body := dataRequest(t, http.MethodPost, unknown, b, "",
		map[string]any{"space_id": testSpaceID}); status != http.StatusNotFound {
		t.Fatalf("unknown app attach -> %d, want 404: %v", status, body)
	}

	url := appDataSpaceURL(base, testAppID)
	if status, body := dataRequest(t, http.MethodPost, url, b, "",
		map[string]any{"space_id": "  "}); status != http.StatusBadRequest {
		t.Fatalf("blank space_id -> %d, want 400: %v", status, body)
	}

	before := len(fake.callNames())
	if status, body := dataRequest(t, http.MethodDelete, url, b, "", nil); status != http.StatusOK {
		t.Fatalf("detach with nothing attached -> %d, want 200: %v", status, body)
	}
	if len(fake.callNames()) != before {
		t.Fatalf("a no-op detach must not call the data store; calls=%v", fake.callNames())
	}
}

// ── helpers ──────────────────────────────────────────────────────────────

func calledOnce(calls []string, want string) bool {
	n := 0
	for _, c := range calls {
		if c == want {
			n++
		}
	}
	return n == 1
}

// TestAppDataSpaceMalformedSpaceIDIsRejected mirrors
// TestDataMalformedSpaceIDIsRejected for the id that arrives in this route's
// BODY rather than a URL segment. A space id becomes a per-space mutex key and
// a rate-limit key inside the store, so an unvalidated one lets a caller mint
// unbounded map entries at one request each.
func TestAppDataSpaceMalformedSpaceIDIsRejected(t *testing.T) {
	b, fake, base := startDataBroker(t)
	seedTestApp(t, b)
	url := appDataSpaceURL(base, testAppID)

	for _, id := range []string{
		"space_1",                     // right prefix, wrong length
		"space_0123456789abcdeg",      // 'g' is not hex
		"SPACE_0123456789ABCDEF",      // wrong case
		"space_0123456789abcdef0",     // too long
		"notaspace",                   // no prefix at all
		"space_0123456789abcdef%20xy", // a segment with junk appended
	} {
		before := len(fake.callNames())
		status, _ := dataRequest(t, http.MethodPost, url, b, "", map[string]any{"space_id": id})
		// Not-found, not 400: a well-formed id the caller may not see answers
		// the same, so the two stay indistinguishable.
		if status != http.StatusNotFound {
			t.Fatalf("attach space_id=%q -> %d, want 404", id, status)
		}
		if names := fake.callNames(); len(names) != before {
			t.Fatalf("a malformed space id reached the store: %v", names[before:])
		}
		if got := readAppManifest(t, b, testAppID).DataSpace; got != "" {
			t.Fatalf("a malformed space id was written to the manifest: %q", got)
		}
	}

	// The guard is not simply a wall: a well-formed id still attaches.
	if status, _ := dataRequest(t, http.MethodPost, url, b, "",
		map[string]any{"space_id": testSpaceID}); status != http.StatusOK {
		t.Fatalf("a well-formed space id -> %d, want 200", status)
	}
}

// TestAppDataSpaceOperatorIsNotDowngradedToAppBuilder is the identity half of
// the 2026-09-18 hardening, applied to a route that sits on the WRONG side of
// the proxy's line. webUIProxyHandler relays "X-WUPHF-Agent: app-builder" on
// app-writer paths (a capability marker) and withholds it on /data (an
// identity). This route lives under /apps, so it gets the relayed header —
// and must still resolve the operator as the operator.
func TestAppDataSpaceOperatorIsNotDowngradedToAppBuilder(t *testing.T) {
	b, fake, base := startDataBroker(t)
	seedTestApp(t, b)

	// Operator traffic that ALSO carries the relayed app-writer header, which
	// is exactly what the operator's own UI sends on an /apps path.
	req := newDataRequest(t, http.MethodPost, appDataSpaceURL(base, testAppID),
		b.Token(), map[string]any{"space_id": testSpaceID})
	req.Header.Set(dataOperatorHeader, b.dataOperatorKey)
	req.Header.Set(botRateLimitHeader, appBuilderSlug)
	status, body := sendDataRequest(t, req)
	if status != http.StatusOK {
		t.Fatalf("operator attach -> %d: %v", status, body)
	}
	// Acting as @app-builder here would attach against THAT bot's access:
	// spaces the operator cannot see, and refusals on spaces they own.
	if actor := fake.actor(); actor != dataspace.ActorHuman {
		t.Fatalf("store actor = %q, want the operator — the relayed app-writer "+
			"header must not re-identify the caller", actor)
	}
}

// TestAppDataSpaceBotIdentityStillResolves is the other side of that coin: the
// header is only ignored for a caller already proven to be the operator, so a
// bot calling directly is still resolved as itself and still refused on a
// space it can only read.
func TestAppDataSpaceBotIdentityStillResolves(t *testing.T) {
	b, fake, base := startDataBroker(t)
	seedTestApp(t, b)
	fake.err = &dataspace.ForbiddenError{SpaceID: testSpaceID, Owner: "cos"}

	status, body := dataRequest(t, http.MethodPost, appDataSpaceURL(base, testAppID),
		b, "ops", map[string]any{"space_id": testSpaceID})
	if status != http.StatusForbidden {
		t.Fatalf("read-only bot attach -> %d, want 403: %v", status, body)
	}
	if actor := fake.actor(); actor != dataspace.Actor("ops") {
		t.Fatalf("store actor = %q, want the calling bot", actor)
	}
}

// TestAppDataSpaceUnidentifiedCallerIsRefused: a process holding only the
// broker token (every bot has it on its command line) is not the operator.
func TestAppDataSpaceUnidentifiedCallerIsRefused(t *testing.T) {
	b, fake, base := startDataBroker(t)
	seedTestApp(t, b)

	req := newDataRequest(t, http.MethodPost, appDataSpaceURL(base, testAppID),
		b.Token(), map[string]any{"space_id": testSpaceID})
	status, body := sendDataRequest(t, req)
	if status != http.StatusForbidden {
		t.Fatalf("unidentified attach -> %d, want 403: %v", status, body)
	}
	if names := fake.callNames(); len(names) != 0 {
		t.Fatalf("an unidentified caller reached the store: %v", names)
	}
	if got := readAppManifest(t, b, testAppID).DataSpace; got != "" {
		t.Fatalf("an unidentified caller wrote the manifest: %q", got)
	}
}
