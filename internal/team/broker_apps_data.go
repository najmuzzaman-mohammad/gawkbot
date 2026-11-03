package team

// broker_apps_data.go binds an App to a DATA SPACE — the structured store bots
// build for themselves (internal/dataspace). An attached space is what the
// app's bridge `data.*` API reads and writes, and what the app's Data tab
// shows instead of the per-app db.json tables.
//
//	GET    /apps/{id}/data-space              -> { space_id }   ("" when none)
//	POST   /apps/{id}/data-space {space_id}   -> { app }        (attach)
//	DELETE /apps/{id}/data-space              -> { app }        (detach)
//
// ── WHY THIS CALLS THE STORE DIRECTLY ────────────────────────────────────
//
// The attachment is TWO facts that must agree: the app manifest's DataSpace
// and the space's AttachedAppIDs. Both are written here, in that order, and a
// failure on the second rolls the first back — so AttachedAppIDs never claims
// an app whose manifest does not point at it.
//
// It calls dataspace.Store.AttachApp / DetachApp directly rather than looping
// back through POST /data/spaces/{space}/apps/{appId} over HTTP. The route and
// the store method enforce exactly the same rule (the Store contract is that
// every method checks its own actor's access), so the loopback would add a
// second listener hop, a second token, and a second place for the two writes
// to diverge, and would buy nothing. broker_data*.go is untouched.
//
// ── AUTHORIZATION ────────────────────────────────────────────────────────
//
// The caller must be able to WRITE the space. Both verbs resolve the actor
// through beginDataRequest, so they inherit the /data rules wholesale — see
// the ACTOR RESOLUTION note in broker_data.go, which is the authority: a bot
// is named by X-WUPHF-Agent, the operator by the per-process operator key only
// webUIProxyHandler can stamp, and anything else is refused. AttachApp then
// returns ForbiddenError for a read-only caller and ErrNotFound for a space
// the caller cannot see, so a bot can neither attach an app to a space it
// cannot write nor probe for one it cannot see.
//
// ONE PLACE THIS ROUTE DIFFERS FROM /data, and it needs handling here.
// This is an app-writer path by URL and a data-identity path by behaviour. The
// web proxy relays "X-WUPHF-Agent: app-builder" on app-writer paths, where it
// is a CAPABILITY marker the app-writer gate honours, and deliberately does
// NOT on /data, where the same header is an IDENTITY. Living under /apps puts
// this route on the app-writer side of that line, so the operator's own UI
// could arrive claiming to be @app-builder and would then attach against THAT
// bot's access instead of the operator's — attaching to spaces the operator
// cannot see, or being refused on spaces they own.
//
// requireOperatorIdentity settles it below. The operator key is unforgeable by
// a bot (it is never written to disk, the environment, or a command line), so
// when it is present the caller IS the operator whatever else the request
// carries, and the relayed capability header must not re-identify them.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/nex-crm/wuphf/internal/dataspace"
)

// appDataSpaceRequest is the POST body: the space to attach.
type appDataSpaceRequest struct {
	SpaceID string `json:"space_id"`
}

// handleAppDataSpace owns /apps/{id}/data-space. Reached from handleAppByID,
// which has already validated the app id.
func (b *Broker) handleAppDataSpace(w http.ResponseWriter, r *http.Request, id string) {
	switch r.Method {
	case http.MethodGet:
		app, err := b.appStore().Manifest(id)
		if err != nil {
			writeAppError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"space_id": app.DataSpace})
	case http.MethodPost:
		var body appDataSpaceRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
			return
		}
		spaceID := strings.TrimSpace(body.SpaceID)
		if spaceID == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "space_id is required"})
			return
		}
		// The id shape is checked BEFORE anything downstream can key state on
		// it, exactly as handleDataSpaceSubpath does for a URL segment: a space
		// id becomes a per-space mutex key and a rate-limit key inside the
		// store, so an unvalidated caller-supplied value lets one request each
		// mint unbounded map entries. Here it arrives in the BODY rather than
		// the path, which changes nothing about that.
		//
		// The answer is the ordinary not-found, not a 400: a well-formed id the
		// caller may not see returns the same thing, so a malformed id and an
		// unseeable one are indistinguishable and probing leaks nothing.
		if !dataspace.IsSpaceID(spaceID) {
			writeDataNotFound(w)
			return
		}
		b.attachAppDataSpace(w, r, id, spaceID)
	case http.MethodDelete:
		b.detachAppDataSpace(w, r, id)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// requireOperatorIdentity drops a relayed bot-identity header when the request
// carries the operator key. See the note at the top of this file: on an /apps
// path the proxy relays "X-WUPHF-Agent: app-builder" as an app-writer
// CAPABILITY, and this route would otherwise read it as an IDENTITY and act as
// that bot instead of as the operator who is actually driving the UI.
//
// Narrow on purpose. It only ever removes a header, only on a request already
// proven to be operator traffic, and never grants anything: a bot calling
// directly has no operator key, so its own header is untouched and it is still
// resolved as itself.
func (b *Broker) requireOperatorIdentity(r *http.Request) {
	if b.requestIsOperator(r) {
		r.Header.Del(botRateLimitHeader)
	}
}

// attachAppDataSpace points the app at spaceID and records the app on the
// space. The store call comes FIRST because it is the one that can refuse: a
// caller who cannot write the space must not leave a manifest claiming it.
func (b *Broker) attachAppDataSpace(w http.ResponseWriter, r *http.Request, appID, spaceID string) {
	b.requireOperatorIdentity(r)
	store, actor, ok := b.beginDataRequest(w, r, spaceID)
	if !ok {
		return
	}
	app, err := b.appStore().Manifest(appID)
	if err != nil {
		writeAppError(w, err)
		return
	}
	previous := strings.TrimSpace(app.DataSpace)
	if _, err := store.AttachApp(r.Context(), actor, spaceID, appID); err != nil {
		writeDataError(w, err)
		return
	}
	if err := b.appStore().SetDataSpace(appID, spaceID); err != nil {
		// Undo the space-side half so AttachedAppIDs never names an app whose
		// manifest does not point back. Best effort: the manifest is the
		// authority the bridge reads, and it is unchanged.
		_, _ = store.DetachApp(r.Context(), actor, spaceID, appID)
		writeAppError(w, err)
		return
	}
	if previous != "" && previous != spaceID {
		// One space per app in v1, so the old space's AttachedAppIDs is now
		// stale. Best effort: the caller may no longer be able to write the old
		// space, and that must not fail an attachment it IS allowed to make.
		_, _ = store.DetachApp(r.Context(), actor, previous, appID)
	}
	app.DataSpace = spaceID
	writeJSON(w, http.StatusOK, map[string]any{"app": app})
}

// detachAppDataSpace clears the attachment. Idempotent: an app with no space
// answers 200 without touching the data store at all.
func (b *Broker) detachAppDataSpace(w http.ResponseWriter, r *http.Request, appID string) {
	app, err := b.appStore().Manifest(appID)
	if err != nil {
		writeAppError(w, err)
		return
	}
	spaceID := strings.TrimSpace(app.DataSpace)
	if spaceID == "" {
		writeJSON(w, http.StatusOK, map[string]any{"app": app})
		return
	}
	b.requireOperatorIdentity(r)
	store, actor, ok := b.beginDataRequest(w, r, spaceID)
	if !ok {
		return
	}
	if _, err := store.DetachApp(r.Context(), actor, spaceID, appID); err != nil {
		writeDataError(w, err)
		return
	}
	if err := b.appStore().SetDataSpace(appID, ""); err != nil {
		writeAppError(w, err)
		return
	}
	app.DataSpace = ""
	writeJSON(w, http.StatusOK, map[string]any{"app": app})
}

// ── Store ────────────────────────────────────────────────────────────────

// Manifest reads an app's manifest WITHOUT its built bundle. Get() also reads
// index.html, which runs to megabytes; every caller that only needs metadata
// (the data-space binding, a listing lookup) should use this instead. An
// unknown id surfaces the underlying os.ErrNotExist so writeAppError maps it
// to 404.
func (s *customAppStore) Manifest(id string) (CustomApp, error) {
	if err := validateCustomAppID(id); err != nil {
		return CustomApp{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.readManifestLocked(id)
}

// SetDataSpace records (or, with an empty spaceID, clears) the data space this
// app reads and writes. Idempotent: setting the value it already holds never
// rewrites the manifest. It touches DataSpace only — no version bump, no
// snapshot, no bytes; attaching a space is not a build.
func (s *customAppStore) SetDataSpace(id, spaceID string) error {
	if err := validateCustomAppID(id); err != nil {
		return err
	}
	spaceID = strings.TrimSpace(spaceID)
	s.mu.Lock()
	defer s.mu.Unlock()
	app, err := s.readManifestLocked(id)
	if err != nil {
		return newCustomAppCallerError("app: %s not found", id)
	}
	if app.DataSpace == spaceID {
		return nil
	}
	app.DataSpace = spaceID
	return s.writeManifestLocked(id, app)
}

// writeManifestLocked serializes app back to app.json. Must hold s.mu.
func (s *customAppStore) writeManifestLocked(id string, app CustomApp) error {
	manifestBytes, err := json.MarshalIndent(app, "", "  ")
	if err != nil {
		return fmt.Errorf("app: marshal manifest: %w", err)
	}
	manifestBytes = append(manifestBytes, '\n')
	path := filepath.Join(s.appDir(id), customAppManifestFile)
	if err := writeFileAtomic(path, manifestBytes, 0o600); err != nil {
		return fmt.Errorf("app: write manifest: %w", err)
	}
	return nil
}
