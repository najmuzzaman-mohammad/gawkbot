package team

// broker_data_test.go exercises the /data HTTP surface end to end over a real
// listener, following the conventions in broker_apps_integration_test.go
// (WUPHF_RUNTIME_HOME to a temp dir, newTestBroker, StartOnPort(0)).
//
// The store itself is a fake. That is deliberate and not a shortcut: the
// behaviour under test here is the HTTP layer — path dispatch, actor
// resolution, status mapping, the batch envelope, the write budget — and a
// fake is the only way to assert that a ForbiddenError becomes a 403 without
// first building the state that would produce one. internal/dataspace's own
// tests own the store's semantics.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/nex-crm/wuphf/internal/dataspace"
)

// ── Fake store ───────────────────────────────────────────────────────────

// fakeDataStore records the actor of the last call and returns whatever the
// test asked it to. Every method funnels through call() so a single err field
// can drive the status-mapping tests.
type fakeDataStore struct {
	mu sync.Mutex
	// err, when set, is returned by every method.
	err error
	// calls records "<method> actor=<actor>" in order.
	calls []string
	// lastActor is the actor of the most recent call.
	lastActor dataspace.Actor
	// result is returned by every batch method.
	result dataspace.Result
}

func (f *fakeDataStore) call(name string, actor dataspace.Actor) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, name)
	f.lastActor = actor
	return f.err
}

func (f *fakeDataStore) actor() dataspace.Actor {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.lastActor
}

func (f *fakeDataStore) callNames() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}

func (f *fakeDataStore) batch(name string, actor dataspace.Actor) (dataspace.Result, error) {
	if err := f.call(name, actor); err != nil {
		return dataspace.Result{}, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.result, nil
}

func (f *fakeDataStore) ListSpaces(_ context.Context, actor dataspace.Actor) ([]dataspace.Space, error) {
	if err := f.call("ListSpaces", actor); err != nil {
		return nil, err
	}
	return []dataspace.Space{{ID: "space_1", Name: "Seed raise", Owner: "cos", CallerLevel: dataspace.LevelWrite}}, nil
}

func (f *fakeDataStore) CreateSpace(_ context.Context, actor dataspace.Actor, name, description string, access dataspace.Access) (dataspace.Space, error) {
	if err := f.call("CreateSpace", actor); err != nil {
		return dataspace.Space{}, err
	}
	return dataspace.Space{ID: "space_1", Name: name, Description: description, Owner: string(actor), Access: access}, nil
}

func (f *fakeDataStore) UpdateSpace(_ context.Context, actor dataspace.Actor, spaceID string, _ dataspace.SpacePatch) (dataspace.Space, error) {
	if err := f.call("UpdateSpace", actor); err != nil {
		return dataspace.Space{}, err
	}
	return dataspace.Space{ID: spaceID}, nil
}

func (f *fakeDataStore) GetSchema(_ context.Context, actor dataspace.Actor, spaceID string) (dataspace.Schema, error) {
	if err := f.call("GetSchema", actor); err != nil {
		return dataspace.Schema{}, err
	}
	return dataspace.Schema{Space: dataspace.Space{ID: spaceID}}, nil
}

func (f *fakeDataStore) CreateObjectTypes(_ context.Context, actor dataspace.Actor, _ string, _ []dataspace.ObjectTypeInput) (dataspace.Result, error) {
	return f.batch("CreateObjectTypes", actor)
}

func (f *fakeDataStore) UpdateObjectType(_ context.Context, actor dataspace.Actor, _, typeRef string, _ dataspace.ObjectTypePatch) (dataspace.ObjectType, error) {
	if err := f.call("UpdateObjectType", actor); err != nil {
		return dataspace.ObjectType{}, err
	}
	return dataspace.ObjectType{ID: typeRef, Slug: typeRef}, nil
}

func (f *fakeDataStore) AddAttributes(_ context.Context, actor dataspace.Actor, _, _ string, _ []dataspace.AttributeInput) (dataspace.Result, error) {
	return f.batch("AddAttributes", actor)
}

func (f *fakeDataStore) UpdateAttribute(_ context.Context, actor dataspace.Actor, _, _, attrRef string, _ dataspace.AttributePatch) (dataspace.Attribute, error) {
	if err := f.call("UpdateAttribute", actor); err != nil {
		return dataspace.Attribute{}, err
	}
	return dataspace.Attribute{ID: attrRef, Slug: attrRef}, nil
}

func (f *fakeDataStore) QueryRecords(_ context.Context, actor dataspace.Actor, _ string, _ dataspace.Query) (dataspace.Page, error) {
	if err := f.call("QueryRecords", actor); err != nil {
		return dataspace.Page{}, err
	}
	return dataspace.Page{Total: 0}, nil
}

func (f *fakeDataStore) GetRecord(_ context.Context, actor dataspace.Actor, _, recordID string) (dataspace.Record, error) {
	if err := f.call("GetRecord", actor); err != nil {
		return dataspace.Record{}, err
	}
	return dataspace.Record{ID: recordID}, nil
}

func (f *fakeDataStore) CreateRecords(_ context.Context, actor dataspace.Actor, _, _ string, _ []dataspace.RecordInput) (dataspace.Result, error) {
	return f.batch("CreateRecords", actor)
}

func (f *fakeDataStore) UpsertRecords(_ context.Context, actor dataspace.Actor, _, _, _ string, _ []dataspace.RecordInput) (dataspace.Result, error) {
	return f.batch("UpsertRecords", actor)
}

func (f *fakeDataStore) UpdateRecord(_ context.Context, actor dataspace.Actor, _, recordID string, _ map[string]any) (dataspace.Record, error) {
	if err := f.call("UpdateRecord", actor); err != nil {
		return dataspace.Record{}, err
	}
	return dataspace.Record{ID: recordID}, nil
}

func (f *fakeDataStore) Link(_ context.Context, actor dataspace.Actor, _ string, _ []dataspace.LinkInput) (dataspace.Result, error) {
	return f.batch("Link", actor)
}

func (f *fakeDataStore) Unlink(_ context.Context, actor dataspace.Actor, _ string, _ []dataspace.LinkInput) (dataspace.Result, error) {
	return f.batch("Unlink", actor)
}

func (f *fakeDataStore) PreviewDelete(_ context.Context, actor dataspace.Actor, _ string, kind dataspace.DeleteKind, ids []string) (dataspace.Preview, error) {
	if err := f.call("PreviewDelete", actor); err != nil {
		return dataspace.Preview{}, err
	}
	return dataspace.Preview{Token: "tok_1", Kind: kind, Impact: dataspace.Impact{Records: len(ids)}}, nil
}

func (f *fakeDataStore) ExecuteDelete(_ context.Context, actor dataspace.Actor, _, _ string) (dataspace.Impact, error) {
	if err := f.call("ExecuteDelete", actor); err != nil {
		return dataspace.Impact{}, err
	}
	return dataspace.Impact{Records: 3}, nil
}

func (f *fakeDataStore) AttachApp(_ context.Context, actor dataspace.Actor, spaceID, appID string) (dataspace.Space, error) {
	if err := f.call("AttachApp", actor); err != nil {
		return dataspace.Space{}, err
	}
	return dataspace.Space{ID: spaceID, AttachedAppIDs: []string{appID}}, nil
}

func (f *fakeDataStore) DetachApp(_ context.Context, actor dataspace.Actor, spaceID, _ string) (dataspace.Space, error) {
	if err := f.call("DetachApp", actor); err != nil {
		return dataspace.Space{}, err
	}
	return dataspace.Space{ID: spaceID}, nil
}

func (f *fakeDataStore) Close() error { return nil }

// compile-time proof the fake really satisfies the contract under test.
var _ dataspace.Store = (*fakeDataStore)(nil)

// ── Harness ──────────────────────────────────────────────────────────────

// startDataBroker boots a broker whose data store is the returned fake.
func startDataBroker(t *testing.T) (*Broker, *fakeDataStore, string) {
	t.Helper()
	t.Setenv("WUPHF_RUNTIME_HOME", t.TempDir())
	fake := &fakeDataStore{}

	dataStoreOverrideMu.Lock()
	previous := newDataStore
	newDataStore = func(string) (dataspace.Store, error) { return fake, nil }
	dataStoreOverrideMu.Unlock()
	t.Cleanup(func() {
		dataStoreOverrideMu.Lock()
		newDataStore = previous
		dataStoreOverrideMu.Unlock()
	})

	b := newTestBroker(t)
	if err := b.StartOnPort(0); err != nil {
		t.Fatalf("start broker: %v", err)
	}
	t.Cleanup(b.Stop)
	return b, fake, fmt.Sprintf("http://%s", b.Addr())
}

// testSpaceID is a well-formed space id (space_<16 hex>). The dispatcher now
// rejects anything else before the store sees it, so paths in these tests must
// use the real shape rather than a readable stand-in.
const testSpaceID = "space_0123456789abcdef"

// dataRequest sends one authenticated /data request.
//
// botSlug "" means THE OPERATOR, and models the operator faithfully: the shipped
// web UI reaches /data only through webUIProxyHandler, which stamps the
// process-local operator key. Sending only the bearer would model a BOT running
// curl, which is what dataUnidentifiedRequest is for.
func dataRequest(t *testing.T, method, url string, b *Broker, botSlug string, body any) (int, map[string]any) {
	t.Helper()
	req := newDataRequest(t, method, url, b.Token(), body)
	if botSlug != "" {
		req.Header.Set(botRateLimitHeader, botSlug)
	} else {
		req.Header.Set(dataOperatorHeader, b.dataOperatorKey)
	}
	return sendDataRequest(t, req)
}

// dataUnidentifiedRequest is the attack in the 2026-09-18 security finding: a
// process holding WUPHF_BROKER_TOKEN (every bot has it on its command line)
// calling /data with no identity at all. It must never be treated as the
// operator.
func dataUnidentifiedRequest(t *testing.T, method, url, token string, body any) (int, map[string]any) {
	t.Helper()
	return sendDataRequest(t, newDataRequest(t, method, url, token, body))
}

func newDataRequest(t *testing.T, method, url, token string, body any) *http.Request {
	t.Helper()
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal body: %v", err)
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, url, reader)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	return req
}

func sendDataRequest(t *testing.T, req *http.Request) (int, map[string]any) {
	t.Helper()
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", req.Method, req.URL, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	out := map[string]any{}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &out)
	}
	return resp.StatusCode, out
}

// ── Happy paths ──────────────────────────────────────────────────────────

// TestDataRoutesHappyPath walks every route in the spec's wire shape and pins
// that each one reaches its own store method with a 200. A route that stops
// dispatching (a typo in the path split, a missing verb) fails here rather
// than silently answering 404 to the UI.
func TestDataRoutesHappyPath(t *testing.T) {
	b, fake, base := startDataBroker(t)
	space := base + "/data/spaces/space_0123456789abcdef"

	cases := []struct {
		name   string
		method string
		url    string
		body   any
		want   string
	}{
		{"list spaces", http.MethodGet, base + "/data/spaces", nil, "ListSpaces"},
		{"create space", http.MethodPost, base + "/data/spaces", map[string]any{"name": "Seed raise"}, "CreateSpace"},
		{"get schema", http.MethodGet, space, nil, "GetSchema"},
		{"patch space", http.MethodPatch, space, map[string]any{"name": "Raise"}, "UpdateSpace"},
		{"create object types", http.MethodPost, space + "/object-types", map[string]any{"items": []any{map[string]any{"name": "Investor"}}}, "CreateObjectTypes"},
		{"patch object type", http.MethodPatch, space + "/object-types/investor", map[string]any{"name": "Backer"}, "UpdateObjectType"},
		{"add attributes", http.MethodPost, space + "/object-types/investor/attributes", map[string]any{"items": []any{map[string]any{"name": "Email", "type": "email"}}}, "AddAttributes"},
		{"patch attribute", http.MethodPatch, space + "/object-types/investor/attributes/email", map[string]any{"name": "Work email"}, "UpdateAttribute"},
		{"query records", http.MethodPost, space + "/records/query", map[string]any{"object_type": "investor", "limit": 30}, "QueryRecords"},
		{"create records", http.MethodPost, space + "/records", map[string]any{"object_type": "investor", "items": []any{map[string]any{"values": map[string]any{"name": "Ada"}}}}, "CreateRecords"},
		{"upsert records", http.MethodPut, space + "/records", map[string]any{"object_type": "investor", "matching_attribute": "email", "items": []any{}}, "UpsertRecords"},
		{"get record", http.MethodGet, space + "/records/rec_1", nil, "GetRecord"},
		{"patch record", http.MethodPatch, space + "/records/rec_1", map[string]any{"values": map[string]any{"name": "Ada"}}, "UpdateRecord"},
		{"link", http.MethodPost, space + "/links", map[string]any{"items": []any{}}, "Link"},
		{"unlink", http.MethodPost, space + "/unlinks", map[string]any{"items": []any{}}, "Unlink"},
		{"delete preview", http.MethodPost, space + "/delete-preview", map[string]any{"kind": "records", "ids": []string{"rec_1"}}, "PreviewDelete"},
		{"delete", http.MethodPost, space + "/delete", map[string]any{"token": "tok_1"}, "ExecuteDelete"},
		{"attach app", http.MethodPost, space + "/apps/app_0123456789abcdef", nil, "AttachApp"},
		{"detach app", http.MethodDelete, space + "/apps/app_0123456789abcdef", nil, "DetachApp"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			before := len(fake.callNames())
			status, body := dataRequest(t, tc.method, tc.url, b, "", tc.body)
			if status != http.StatusOK {
				t.Fatalf("%s %s -> %d: %v", tc.method, tc.url, status, body)
			}
			names := fake.callNames()
			if len(names) != before+1 {
				t.Fatalf("store calls = %v, want exactly one more after %d", names, before)
			}
			if got := names[len(names)-1]; got != tc.want {
				t.Fatalf("store method = %q, want %q", got, tc.want)
			}
		})
	}
}

// ── Actor resolution ─────────────────────────────────────────────────────

// TestDataActorResolution is the security test. The proxy-stamped operator key
// is the operator, the launcher-stamped header names a bot, and nothing a
// caller puts in a body or a query string can change either.
func TestDataActorResolution(t *testing.T) {
	b, fake, base := startDataBroker(t)

	t.Run("the operator key is the operator", func(t *testing.T) {
		status, _ := dataRequest(t, http.MethodGet, base+"/data/spaces", b, "", nil)
		if status != http.StatusOK {
			t.Fatalf("status = %d, want 200", status)
		}
		if got := fake.actor(); got != dataspace.ActorHuman {
			t.Fatalf("actor = %q, want %q", got, dataspace.ActorHuman)
		}
	})

	t.Run("bot header names the bot", func(t *testing.T) {
		status, _ := dataRequest(t, http.MethodGet, base+"/data/spaces", b, "recruiter", nil)
		if status != http.StatusOK {
			t.Fatalf("status = %d, want 200", status)
		}
		if got := fake.actor(); got != dataspace.Actor("recruiter") {
			t.Fatalf("actor = %q, want recruiter", got)
		}
	})

	t.Run("bot header is lowercased", func(t *testing.T) {
		if _, _ = dataRequest(t, http.MethodGet, base+"/data/spaces", b, "Recruiter", nil); fake.actor() != dataspace.Actor("recruiter") {
			t.Fatalf("actor = %q, want recruiter", fake.actor())
		}
	})

	// The forging cases. A bot slug in the BODY or the QUERY must be inert:
	// the only thing that can name a bot is the header the launcher sets.
	t.Run("a slug in the body cannot forge an identity", func(t *testing.T) {
		status, _ := dataRequest(t, http.MethodPost, base+"/data/spaces", b, "",
			map[string]any{"name": "Forged", "actor": "recruiter", "owner": "recruiter", "created_by": "recruiter"})
		if status != http.StatusOK {
			t.Fatalf("status = %d, want 200", status)
		}
		if got := fake.actor(); got != dataspace.ActorHuman {
			t.Fatalf("actor = %q, want the operator — a body field forged a bot identity", got)
		}
	})

	t.Run("a slug in the query cannot forge an identity", func(t *testing.T) {
		status, _ := dataRequest(t, http.MethodGet, base+"/data/spaces?actor=recruiter&bot=recruiter", b, "", nil)
		if status != http.StatusOK {
			t.Fatalf("status = %d, want 200", status)
		}
		if got := fake.actor(); got != dataspace.ActorHuman {
			t.Fatalf("actor = %q, want the operator — a query param forged a bot identity", got)
		}
	})

	// "human" is shaped like a legal bot slug, so without an explicit reject a
	// bot could claim the operator's write-everywhere access with one header.
	for _, reserved := range []string{"human", "you", "system", "operator"} {
		t.Run("reserved identity "+reserved+" is rejected", func(t *testing.T) {
			before := len(fake.callNames())
			status, body := dataRequest(t, http.MethodGet, base+"/data/spaces", b, reserved, nil)
			if status != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 (body %v)", status, body)
			}
			if len(fake.callNames()) != before {
				t.Fatalf("store was called for a reserved identity")
			}
		})
	}

	t.Run("a malformed slug is rejected", func(t *testing.T) {
		before := len(fake.callNames())
		status, _ := dataRequest(t, http.MethodGet, base+"/data/spaces", b, "not a slug", nil)
		if status != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", status)
		}
		if len(fake.callNames()) != before {
			t.Fatalf("store was called for a malformed slug")
		}
	})
}

// TestDataRoutesRequireAuth pins that /data is inside the auth boundary.
func TestDataRoutesRequireAuth(t *testing.T) {
	_, fake, base := startDataBroker(t)
	for _, path := range []string{"/data/spaces", "/data/spaces/space_0123456789abcdef", "/data/anything"} {
		req, _ := http.NewRequest(http.MethodGet, base+path, nil)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("GET %s without a token -> %d, want 401", path, resp.StatusCode)
		}
	}
	if names := fake.callNames(); len(names) != 0 {
		t.Fatalf("store reached without auth: %v", names)
	}
}

// ── Status mapping ───────────────────────────────────────────────────────

// TestDataErrorMapping pins the documented status codes and, for the two the
// UI reads programmatically, the body shape.
func TestDataErrorMapping(t *testing.T) {
	b, fake, base := startDataBroker(t)
	space := base + "/data/spaces/space_0123456789abcdef"

	t.Run("a space the caller cannot see is 404", func(t *testing.T) {
		fake.err = dataspace.ErrNotFound
		t.Cleanup(func() { fake.err = nil })
		status, body := dataRequest(t, http.MethodGet, space, b, "recruiter", nil)
		if status != http.StatusNotFound {
			t.Fatalf("status = %d, want 404", status)
		}
		if body["error"] != "not found" {
			t.Fatalf("body = %v, want a plain not-found message", body)
		}
	})

	t.Run("a read-only write is 403 naming the owner", func(t *testing.T) {
		fake.err = &dataspace.ForbiddenError{SpaceID: "space_1", Owner: "cos"}
		t.Cleanup(func() { fake.err = nil })
		status, body := dataRequest(t, http.MethodPost, space+"/records", b, "recruiter",
			map[string]any{"object_type": "investor", "items": []any{}})
		if status != http.StatusForbidden {
			t.Fatalf("status = %d, want 403", status)
		}
		message, _ := body["error"].(string)
		if message == "" || !bytes.Contains([]byte(message), []byte("@cos")) {
			t.Fatalf("body = %v, want a message naming the owner", body)
		}
	})

	t.Run("a validation failure is 400 carrying the attribute", func(t *testing.T) {
		fake.err = dataspace.Invalid("stage", "%q is not an option. Valid options: Intro, Pitched.", "urgent")
		t.Cleanup(func() { fake.err = nil })
		status, body := dataRequest(t, http.MethodPatch, space+"/records/rec_1", b, "",
			map[string]any{"values": map[string]any{"stage": "urgent"}})
		if status != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", status)
		}
		if body["attribute"] != "stage" {
			t.Fatalf("body = %v, want attribute=stage so the UI can place the message", body)
		}
		if message, _ := body["error"].(string); message == "" {
			t.Fatalf("body = %v, want an actionable message", body)
		}
	})

	// An unexpected store failure may carry a file path or SQL text. Neither
	// belongs in a response body, so the 500 arm is a fixed sentence.
	t.Run("an unexpected failure leaks nothing", func(t *testing.T) {
		fake.err = fmt.Errorf("open /Users/someone/.wuphf/data/space_1.db: no such file")
		t.Cleanup(func() { fake.err = nil })
		status, body := dataRequest(t, http.MethodGet, space, b, "", nil)
		if status != http.StatusInternalServerError {
			t.Fatalf("status = %d, want 500", status)
		}
		message, _ := body["error"].(string)
		if message != "data store error" {
			t.Fatalf("error = %q, want the fixed sentence", message)
		}
	})

	t.Run("an unknown route under /data is 404", func(t *testing.T) {
		for _, path := range []string{"/data/nope", "/data/spaces/space_0123456789abcdef/nope", "/data/spaces/space_0123456789abcdef/records/rec_1/extra"} {
			status, _ := dataRequest(t, http.MethodGet, base+path, b, "", nil)
			if status != http.StatusNotFound {
				t.Fatalf("GET %s -> %d, want 404", path, status)
			}
		}
	})

	t.Run("a wrong verb is 405", func(t *testing.T) {
		status, _ := dataRequest(t, http.MethodDelete, base+"/data/spaces", b, "", nil)
		if status != http.StatusMethodNotAllowed {
			t.Fatalf("status = %d, want 405", status)
		}
	})
}

// ── Batch envelope ───────────────────────────────────────────────────────

// TestDataBatchPartialFailure pins that one bad item never fails the call:
// the envelope comes back with a 200 and per-entry outcomes.
func TestDataBatchPartialFailure(t *testing.T) {
	b, fake, base := startDataBroker(t)
	fake.result = dataspace.Result{
		Succeeded: 1,
		Failed:    1,
		Summary:   "1 created, 1 failed",
		Entries: []dataspace.Entry{
			{Index: 0, Identifier: "Ada", Status: dataspace.StatusOK, ID: "rec_1"},
			{Index: 1, Identifier: "Grace", Status: dataspace.StatusFailed, Error: `"urgent" is not an option`, Attribute: "stage"},
		},
	}

	status, body := dataRequest(t, http.MethodPost, base+"/data/spaces/space_0123456789abcdef/records", b, "cos",
		map[string]any{"object_type": "investor", "items": []any{
			map[string]any{"values": map[string]any{"name": "Ada"}},
			map[string]any{"values": map[string]any{"name": "Grace", "stage": "urgent"}},
		}})
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200 — a partial failure is still a successful batch", status)
	}
	if body["succeeded"] != float64(1) || body["failed"] != float64(1) {
		t.Fatalf("envelope = %v, want succeeded=1 failed=1", body)
	}
	entries, _ := body["entries"].([]any)
	if len(entries) != 2 {
		t.Fatalf("entries = %v, want 2 in request order", body["entries"])
	}
	failed, _ := entries[1].(map[string]any)
	if failed["status"] != string(dataspace.StatusFailed) || failed["attribute"] != "stage" {
		t.Fatalf("failed entry = %v, want status=failed attribute=stage", failed)
	}
}

// ── Rate limiting ────────────────────────────────────────────────────────

// TestDataWriteRateLimit pins that a looping caller is cut off by the SAME
// rolling budget the app DB writes use, and that reads stay unmetered.
func TestDataWriteRateLimit(t *testing.T) {
	b, _, base := startDataBroker(t)
	url := base + "/data/spaces/space_0123456789abcdef/records"
	body := map[string]any{"object_type": "investor", "items": []any{}}

	limited := false
	for i := 0; i < appDBWriteLimit+5; i++ {
		status, _ := dataRequest(t, http.MethodPost, url, b, "cos", body)
		if status == http.StatusTooManyRequests {
			limited = true
			break
		}
		if status != http.StatusOK {
			t.Fatalf("write %d -> %d, want 200 or 429", i, status)
		}
	}
	if !limited {
		t.Fatalf("no 429 after %d writes; the write budget is not wired", appDBWriteLimit+5)
	}

	// Reads are unmetered even once the write bucket is full.
	status, _ := dataRequest(t, http.MethodGet, base+"/data/spaces", b, "cos", nil)
	if status != http.StatusOK {
		t.Fatalf("read after the write budget filled -> %d, want 200", status)
	}

	// The bucket is per actor + space, so a different bot is untouched.
	status, _ = dataRequest(t, http.MethodPost, url, b, "recruiter", body)
	if status != http.StatusOK {
		t.Fatalf("another bot's first write -> %d, want 200 — buckets are not isolated", status)
	}
}

// TestDataStoreUnavailable pins the degraded path: with no store
// implementation wired the routes answer 503, not a panic and not a 500 that
// looks like a bug in the caller.
func TestDataStoreUnavailable(t *testing.T) {
	t.Setenv("WUPHF_RUNTIME_HOME", t.TempDir())
	dataStoreOverrideMu.Lock()
	previous := newDataStore
	newDataStore = nil
	dataStoreOverrideMu.Unlock()
	t.Cleanup(func() {
		dataStoreOverrideMu.Lock()
		newDataStore = previous
		dataStoreOverrideMu.Unlock()
	})

	b := newTestBroker(t)
	if err := b.StartOnPort(0); err != nil {
		t.Fatalf("start broker: %v", err)
	}
	defer b.Stop()
	status, _ := dataRequest(t, http.MethodGet, fmt.Sprintf("http://%s/data/spaces", b.Addr()), b, "", nil)
	if status != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", status)
	}
}

// ── Fail-closed actor resolution (2026-09-18 security finding) ───────────

// TestDataUnidentifiedCallerHasNoAccess is the regression test for the finding
// that blocked this merge: a caller holding the broker token but naming no
// identity used to resolve to dataspace.ActorHuman, the operator, who has
// write on EVERY space. Every bot holds WUPHF_BROKER_TOKEN and
// WUPHF_BROKER_BASE_URL on its own command line and can run a shell, so
// `curl -H "Authorization: Bearer $WUPHF_BROKER_TOKEN" $URL/data/spaces` read
// and wrote the whole office. Omitting a header impersonates nobody, so the
// reserved-slug denylist could never have caught it.
func TestDataUnidentifiedCallerHasNoAccess(t *testing.T) {
	b, fake, base := startDataBroker(t)

	// The stakes, in the store's own terms: the operator writes a bot's
	// PRIVATE space, and another bot cannot even see it. That gap is exactly
	// what an unidentified caller used to be handed.
	private := dataspace.Space{
		ID:     testSpaceID,
		Owner:  "cos",
		Access: dataspace.Access{Scope: dataspace.ScopePrivate},
	}
	if got := dataspace.LevelFor(private, dataspace.ActorHuman); got != dataspace.LevelWrite {
		t.Fatalf("LevelFor(private space owned by @cos, operator) = %q, want write", got)
	}
	if got := dataspace.LevelFor(private, dataspace.Actor("recruiter")); got != dataspace.LevelNone {
		t.Fatalf("LevelFor(private space owned by @cos, another bot) = %q, want none", got)
	}

	space := base + "/data/spaces/" + testSpaceID
	cases := []struct {
		name   string
		method string
		url    string
		body   any
	}{
		{"list another bot's spaces", http.MethodGet, base + "/data/spaces", nil},
		{"read a bot's private space", http.MethodGet, space, nil},
		{"write into a bot's private space", http.MethodPost, space + "/records",
			map[string]any{"object_type": "investor", "items": []any{map[string]any{"values": map[string]any{"name": "Ada"}}}}},
		{"create a space owned by the operator", http.MethodPost, base + "/data/spaces",
			map[string]any{"name": "Forged"}},
		{"delete a space", http.MethodPost, space + "/delete", map[string]any{"token": "tok_1"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			before := len(fake.callNames())
			status, body := dataUnidentifiedRequest(t, tc.method, tc.url, b.Token(), tc.body)
			if status != http.StatusForbidden {
				t.Fatalf("%s %s -> %d, want 403 (body %v)", tc.method, tc.url, status, body)
			}
			if names := fake.callNames(); len(names) != before {
				t.Fatalf("an unidentified caller reached the store: %v", names[before:])
			}
		})
	}
}

// TestDataUnidentifiedCallerIsRateLimited pins the second half of the finding.
// rateLimitMiddleware gives an authenticated caller with no X-WUPHF-Agent
// header NO per-bot bucket and bypasses the per-IP one, so an anonymous loop
// against /data was unmetered as well as unauthorized. Reads are deliberately
// unmetered for identified callers, so the refusal itself has to carry the
// budget.
func TestDataUnidentifiedCallerIsRateLimited(t *testing.T) {
	b, fake, base := startDataBroker(t)

	limited := false
	for i := 0; i < appDBWriteLimit+5; i++ {
		status, body := dataUnidentifiedRequest(t, http.MethodGet, base+"/data/spaces", b.Token(), nil)
		if status == http.StatusTooManyRequests {
			limited = true
			break
		}
		if status != http.StatusForbidden {
			t.Fatalf("unidentified read %d -> %d, want 403 or 429 (body %v)", i, status, body)
		}
	}
	if !limited {
		t.Fatalf("no 429 after %d unidentified reads; anonymous /data traffic is unmetered", appDBWriteLimit+5)
	}
	if names := fake.callNames(); len(names) != 0 {
		t.Fatalf("an unidentified caller reached the store: %v", names)
	}

	// The anonymous bucket must not starve the operator, whose reads stay
	// unmetered exactly as before.
	if status, _ := dataRequest(t, http.MethodGet, base+"/data/spaces", b, "", nil); status != http.StatusOK {
		t.Fatalf("operator read after an anonymous flood -> %d, want 200", status)
	}
}

// TestDataOperatorUIPathHasFullAccess models the real operator path rather
// than asserting a header by hand: the shipped web client (web/src/api/client.ts)
// talks to "/api", which is webUIProxyHandler, which attaches the bearer
// server-side. Run the actual proxy handler in front of the actual broker and
// require that both a read and a write land as the operator.
func TestDataOperatorUIPathHasFullAccess(t *testing.T) {
	b, fake, base := startDataBroker(t)
	proxy := b.webUIProxyHandler(base, "/api")

	// The browser sends no Authorization header of its own; the proxy adds it.
	rec := httptest.NewRecorder()
	proxy.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/data/spaces", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/data/spaces -> %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	if got := fake.actor(); got != dataspace.ActorHuman {
		t.Fatalf("actor through the web UI proxy = %q, want %q", got, dataspace.ActorHuman)
	}

	rec = httptest.NewRecorder()
	write := httptest.NewRequest(http.MethodPost, "/api/data/spaces",
		bytes.NewReader([]byte(`{"name":"Seed raise"}`)))
	write.Header.Set("Content-Type", "application/json")
	proxy.ServeHTTP(rec, write)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /api/data/spaces -> %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	if got := fake.actor(); got != dataspace.ActorHuman {
		t.Fatalf("write actor through the web UI proxy = %q, want %q", got, dataspace.ActorHuman)
	}
}

// TestDataProxyDropsAppBuilderIdentity covers the second finding. The proxy
// relays X-WUPHF-Agent: app-builder on a same-origin request so the operator's
// UI can drive the App Builder WRITER path. On /data the same header is an
// IDENTITY: it would let any same-origin script act as the bot @app-builder,
// and would downgrade the operator's own UI to that bot. The dev app frame is
// allow-same-origin, so this is reachable in practice.
func TestDataProxyDropsAppBuilderIdentity(t *testing.T) {
	b, fake, base := startDataBroker(t)
	proxy := b.webUIProxyHandler(base, "/api")

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/data/spaces", nil)
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	req.Header.Set(botRateLimitHeader, appBuilderSlug)
	proxy.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	if got := fake.actor(); got == dataspace.Actor(appBuilderSlug) {
		t.Fatalf("a same-origin script acted as @%s on /data", appBuilderSlug)
	} else if got != dataspace.ActorHuman {
		t.Fatalf("actor = %q, want the operator", got)
	}
}

// TestWebProxyAppBuilderRelayIsUnchangedOffData is the other half: the app
// writer path must keep working exactly as it did. Asserted on the wire, by
// reading the headers the proxy actually emits upstream.
func TestWebProxyAppBuilderRelayIsUnchangedOffData(t *testing.T) {
	b := newTestBroker(t)

	var mu sync.Mutex
	var seen http.Header
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = r.Header.Clone()
		mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}))
	t.Cleanup(upstream.Close)
	proxy := b.webUIProxyHandler(upstream.URL, "/api")

	send := func(path string) http.Header {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, path, nil)
		req.Header.Set("Sec-Fetch-Site", "same-origin")
		req.Header.Set(botRateLimitHeader, appBuilderSlug)
		proxy.ServeHTTP(httptest.NewRecorder(), req)
		mu.Lock()
		defer mu.Unlock()
		return seen.Clone()
	}

	if got := send("/api/apps/app_0123456789abcdef/build").Get(botRateLimitHeader); got != appBuilderSlug {
		t.Fatalf("app writer path relayed %q, want %q — the exception regressed", got, appBuilderSlug)
	}
	onData := send("/api/data/spaces")
	if got := onData.Get(botRateLimitHeader); got != "" {
		t.Fatalf("/data received X-WUPHF-Agent %q, want it dropped", got)
	}
	if got := onData.Get(dataOperatorHeader); got != b.dataOperatorKey {
		t.Fatalf("/data operator header = %q, want the process key", got)
	}
	// The key is per process and never leaves it, so it cannot be a constant.
	if b.dataOperatorKey == "" || b.dataOperatorKey == b.Token() {
		t.Fatalf("operator key must be its own secret, not the broker token")
	}
}

// TestDataMalformedSpaceIDIsRejected pins that a space id is validated in the
// dispatcher. Path segments become per-space mutex keys and rate-limit keys
// inside the store, so an unvalidated one lets a caller mint unbounded map
// entries. dataspace.IsSpaceID existed for this and was called nowhere.
func TestDataMalformedSpaceIDIsRejected(t *testing.T) {
	b, fake, base := startDataBroker(t)

	for _, id := range []string{
		"space_1",                     // right prefix, wrong length
		"space_0123456789abcdeg",      // 'g' is not hex
		"SPACE_0123456789ABCDEF",      // wrong case
		"space_0123456789abcdef0",     // too long
		"notaspace",                   // no prefix at all
		"space_0123456789abcdef%20xy", // a segment with junk appended
	} {
		before := len(fake.callNames())
		status, _ := dataRequest(t, http.MethodGet, base+"/data/spaces/"+id, b, "", nil)
		if status != http.StatusNotFound {
			t.Fatalf("GET /data/spaces/%s -> %d, want 404", id, status)
		}
		if names := fake.callNames(); len(names) != before {
			t.Fatalf("a malformed space id reached the store: %v", names[before:])
		}
	}

	// A well-formed id still dispatches, so the guard is not simply a wall.
	if status, _ := dataRequest(t, http.MethodGet, base+"/data/spaces/"+testSpaceID, b, "", nil); status != http.StatusOK {
		t.Fatalf("a well-formed space id -> %d, want 200", status)
	}
}

// TestDataStoreOpenFailureIsRetried pins that a transient open failure is not
// cached for the life of the process. With sync.Once, one unlucky moment (a
// home not mounted yet, a full disk, a lock another process held) took /data
// down until the broker restarted.
func TestDataStoreOpenFailureIsRetried(t *testing.T) {
	t.Setenv("WUPHF_RUNTIME_HOME", t.TempDir())
	fake := &fakeDataStore{}

	var mu sync.Mutex
	attempts := 0
	dataStoreOverrideMu.Lock()
	previous := newDataStore
	newDataStore = func(string) (dataspace.Store, error) {
		mu.Lock()
		defer mu.Unlock()
		attempts++
		if attempts == 1 {
			return nil, fmt.Errorf("open data root: no such file or directory")
		}
		return fake, nil
	}
	dataStoreOverrideMu.Unlock()
	t.Cleanup(func() {
		dataStoreOverrideMu.Lock()
		newDataStore = previous
		dataStoreOverrideMu.Unlock()
	})

	b := newTestBroker(t)
	if err := b.StartOnPort(0); err != nil {
		t.Fatalf("start broker: %v", err)
	}
	t.Cleanup(b.Stop)
	base := fmt.Sprintf("http://%s", b.Addr())

	if status, _ := dataRequest(t, http.MethodGet, base+"/data/spaces", b, "", nil); status != http.StatusInternalServerError {
		t.Fatalf("first request after an open failure -> %d, want 500", status)
	}
	if status, body := dataRequest(t, http.MethodGet, base+"/data/spaces", b, "", nil); status != http.StatusOK {
		t.Fatalf("second request -> %d, want 200 — a transient open failure was memoized (body %v)", status, body)
	}
	if names := fake.callNames(); len(names) != 1 {
		t.Fatalf("store calls = %v, want exactly the retried one", names)
	}
}
