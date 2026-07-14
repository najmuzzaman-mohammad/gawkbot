package team

// custom_app.go owns the storage + validation for agent-generated internal
// tools ("Apps"). New Apps are OpenUI Lang documents rendered by the trusted
// WUPHF shell. Legacy HTML apps remain readable in their sandboxed iframe.
//
// Why a dedicated store instead of the wiki git worker:
//   - Apps are a distinct concern from the curated wiki; coupling them to the
//     wiki write queue would entangle two unrelated serializers.
//   - v1 versioning is a monotonic counter on the manifest, not git history.
//
// Security model: OpenUI apps are validated against a pinned component/tool
// contract and rendered by the trusted shell. Legacy HTML keeps the original
// opaque-origin iframe boundary and CSP; its HTML validator remains below.

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/nex-crm/wuphf/internal/config"
	"github.com/nex-crm/wuphf/templates"
)

const (
	customAppEntry                = "index.html"
	customAppOpenUIEntry          = "app.openui"
	customAppRepresentationHTML   = "html"
	customAppRepresentationOpenUI = "openui"
	customAppOpenUIVersion        = "0.5"
	customAppOpenUILibrary        = "wuphf-app-v1"
	customAppOpenUILibraryHash    = "06e4b7ef3e2e2ca65a3cbe9b966d502210270331b475c21ab99ad5e90d51489e"
	customAppProviderVersion      = "1"
	customAppMaxOpenUIBytes       = 256 * 1024
	// Singlefile React bundles run larger than rich artifacts (the whole app +
	// inlined CSS lives in one document), so the ceiling is higher.
	customAppMaxHTMLBytes = 4 * 1024 * 1024
	customAppDefaultIcon  = "🧩"
	customAppManifestFile = "app.json"
	customAppMaxNameBytes = 120
	// Version snapshots + source live next to the manifest so an edit can roll
	// back to a known-good build, and the App Builder can edit real source
	// instead of regenerating from prose.
	customAppVersionsDir        = "versions"
	customAppVersionMetaFile    = "meta.json"
	customAppSourceDir          = "src"
	customAppMaxSourceFiles     = 300
	customAppMaxSourceFileBytes = 512 * 1024
	// customAppStatusBuilding marks a pre-scaffolded app that has no published
	// build yet — the source exists (so the live dev preview can boot) but the
	// App Builder has not run register_app. A missing/empty status means
	// "ready" (back-compat with manifests written before this field existed).
	customAppStatusBuilding = "building"
	customAppStatusReady    = "ready"
)

// customAppPreservedSrcDirs are top-level entries under src/ that a publish must
// NOT delete: build/install artifacts that are expensive to regenerate and that
// a running dev server depends on. Keeping node_modules across a register_app
// lets the live Vite server hot-reload the freshly published source instead of
// crashing on a vanished dependency tree. They are also skipped when reading
// source back (get_app) so the agent never sees node_modules.
var customAppPreservedSrcDirs = map[string]bool{
	"node_modules": true,
	"dist":         true,
	".vite":        true,
}

// CustomApp is the durable manifest for an agent-generated internal tool. Its
// representation-specific body lives next to it at Entry so listings stay cheap.
type CustomApp struct {
	ID          string `json:"id"`
	Slug        string `json:"slug"`
	Name        string `json:"name"`
	Icon        string `json:"icon"`
	Summary     string `json:"summary,omitempty"`
	Description string `json:"description,omitempty"`
	Entry       string `json:"entry"`
	// Representation is omitted by manifests written before OpenUI Apps and is
	// normalized to "html" at the storage boundary.
	Representation    string `json:"representation,omitempty"`
	OpenUIVersion     string `json:"openuiVersion,omitempty"`
	OpenUILibrary     string `json:"openuiLibrary,omitempty"`
	OpenUILibraryHash string `json:"openuiLibraryHash,omitempty"`
	ProviderVersion   string `json:"providerVersion,omitempty"`
	Version           int    `json:"version"`
	// Status is "building" for a pre-scaffolded app awaiting its first publish,
	// or "ready"/"" for a published app. Lets the sidebar hide drafts while the
	// build task's live preview still resolves them.
	Status string `json:"status,omitempty"`
	// EditChannel is the slug of the app's persistent edit thread — the channel
	// of the App Builder task that created/improves it (`task-<id>`). Binding the
	// app to a stable channel lets the FE mount a per-app "chat to edit" panel:
	// a human note posted there re-engages the App Builder owner (via the
	// existing task_followup wake) to read get_app + republish with register_app.
	// Empty for apps minted before this field existed or registered html-only
	// (no owning task) — those simply have no edit thread until the next build.
	EditChannel string `json:"editChannel,omitempty"`
	CreatedBy   string `json:"createdBy"`
	UpdatedBy   string `json:"updatedBy,omitempty"`
	CreatedAt   string `json:"createdAt"`
	UpdatedAt   string `json:"updatedAt"`
	ContentHash string `json:"contentHash"`
}

// CustomAppWriteRequest is the create/update payload. An empty ID creates a new
// app; a populated ID updates the existing one in place (bumping Version).
type CustomAppWriteRequest struct {
	ID              string `json:"id,omitempty"`
	Name            string `json:"name"`
	Icon            string `json:"icon,omitempty"`
	Summary         string `json:"summary,omitempty"`
	Description     string `json:"description,omitempty"`
	HTML            string `json:"html,omitempty"`
	OpenUI          string `json:"openui,omitempty"`
	ExpectedVersion *int   `json:"expected_version,omitempty"`
	Actor           string `json:"actor,omitempty"`
	// Files is the app's source project (relative path -> content), persisted
	// under src/ so a later edit modifies real files instead of regenerating
	// from prose. Optional; nil leaves any existing source untouched. Build
	// artifacts (node_modules/, dist/) are rejected.
	Files map[string]string `json:"files,omitempty"`
}

var errCustomAppCaller = errors.New("app: caller error")
var errCustomAppConflict = errors.New("app: version conflict")

type customAppCallerError struct{ err error }

func (e customAppCallerError) Error() string   { return e.err.Error() }
func (e customAppCallerError) Unwrap() []error { return []error{errCustomAppCaller, e.err} }

func newCustomAppCallerError(format string, args ...any) error {
	return customAppCallerError{err: fmt.Errorf(format, args...)}
}

func isCustomAppCallerError(err error) bool { return errors.Is(err, errCustomAppCaller) }

func newCustomAppConflictError(format string, args ...any) error {
	return fmt.Errorf("%w: %s", errCustomAppConflict, fmt.Sprintf(format, args...))
}

func isCustomAppConflictError(err error) bool { return errors.Is(err, errCustomAppConflict) }

// CustomAppsRootDir returns <runtime-home>/.wuphf/apps, honouring
// config.RuntimeHomeDir so dev runs stay isolated from prod (same discipline as
// WikiRootDir).
func CustomAppsRootDir() string {
	home := strings.TrimSpace(config.RuntimeHomeDir())
	if home == "" {
		return filepath.Join(".wuphf", "apps")
	}
	return filepath.Join(home, ".wuphf", "apps")
}

// customAppStore is the standalone persistence layer for Apps. All operations
// serialize on mu; reads and writes both lock so a listing never observes a
// half-written manifest.
type customAppStore struct {
	root string
	mu   sync.Mutex
	// buildBundle compiles the persisted source dir into the sealed single-file
	// bundle bytes. Defaults to the real bun-driven buildAppBundle; tests inject a
	// hermetic stub so they need neither bun nor the network. Always set —
	// newCustomAppStore wires the default.
	buildBundle func(srcDir string) ([]byte, error)
	// publishMu serializes concurrent publishes OF THE SAME app id. The server-side
	// build runs WITHOUT the store-wide mu (so reads/listings aren't starved for
	// the multi-second build), so this per-app gate is what stops two builds from
	// racing in the same src/ dir. Keyed by app id; entries are created on demand.
	publishMu sync.Map // map[string]*sync.Mutex
}

func newCustomAppStore(root string) *customAppStore {
	return &customAppStore{root: root, buildBundle: buildAppBundle}
}

// publishLock returns the per-app publish mutex, creating it on first use.
func (s *customAppStore) publishLock(id string) *sync.Mutex {
	m, _ := s.publishMu.LoadOrStore(id, &sync.Mutex{})
	return m.(*sync.Mutex)
}

func validateCustomAppID(id string) error {
	id = strings.TrimSpace(id)
	if len(id) != len("app_")+16 || !strings.HasPrefix(id, "app_") {
		return newCustomAppCallerError("app: invalid id %q", id)
	}
	for _, ch := range strings.TrimPrefix(id, "app_") {
		if !((ch >= 'a' && ch <= 'f') || (ch >= '0' && ch <= '9')) {
			return newCustomAppCallerError("app: invalid id %q", id)
		}
	}
	return nil
}

func customAppID(slug, name, createdAt string) string {
	sum := sha256.Sum256([]byte(strings.Join([]string{slug, name, createdAt}, "\x00")))
	return "app_" + hex.EncodeToString(sum[:])[:16]
}

func customAppContentHash(htmlBody string) string {
	sum := sha256.Sum256([]byte(htmlBody))
	return hex.EncodeToString(sum[:])
}

func customAppRepresentation(app CustomApp) string {
	if app.Representation == "" {
		return customAppRepresentationHTML
	}
	return app.Representation
}

func customAppEntryForRepresentation(representation string) string {
	if representation == customAppRepresentationOpenUI {
		return customAppOpenUIEntry
	}
	return customAppEntry
}

func validateCustomAppManifest(app CustomApp) error {
	switch customAppRepresentation(app) {
	case customAppRepresentationHTML:
		if app.Entry != customAppEntry {
			return fmt.Errorf("app: corrupt html manifest entry")
		}
		if app.OpenUIVersion != "" || app.OpenUILibrary != "" || app.OpenUILibraryHash != "" || app.ProviderVersion != "" {
			return fmt.Errorf("app: corrupt mixed representation manifest")
		}
	case customAppRepresentationOpenUI:
		if app.Entry != customAppOpenUIEntry || app.OpenUIVersion != customAppOpenUIVersion || app.OpenUILibrary != customAppOpenUILibrary || app.OpenUILibraryHash != customAppOpenUILibraryHash || app.ProviderVersion != customAppProviderVersion {
			return fmt.Errorf("app: unsupported or corrupt OpenUI contract")
		}
	default:
		return fmt.Errorf("app: unknown representation %q", app.Representation)
	}
	return nil
}

func (s *customAppStore) appDir(id string) string {
	return filepath.Join(s.root, id)
}

// List returns all apps, most-recently-updated first.
func (s *customAppStore) List() ([]CustomApp, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entries, err := os.ReadDir(s.root)
	if err != nil {
		if os.IsNotExist(err) {
			return []CustomApp{}, nil
		}
		return nil, fmt.Errorf("app: read registry: %w", err)
	}
	out := make([]CustomApp, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		// Only iterate well-formed app ids so a stray/foreign directory name can
		// never be joined onto the apps root (defense in depth — os.ReadDir never
		// returns ".."/absolute names, but the id shape is the contract).
		if err := validateCustomAppID(entry.Name()); err != nil {
			continue
		}
		app, err := s.readManifestLocked(entry.Name())
		if err != nil {
			continue // skip unreadable/foreign dirs rather than fail the whole list
		}
		out = append(out, app)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].UpdatedAt == out[j].UpdatedAt {
			return out[i].ID > out[j].ID
		}
		return out[i].UpdatedAt > out[j].UpdatedAt
	})
	return out, nil
}

// Get returns the validated manifest plus its representation-specific body.
func (s *customAppStore) Get(id string) (CustomApp, string, error) {
	if err := validateCustomAppID(id); err != nil {
		return CustomApp{}, "", err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	app, err := s.readManifestLocked(id)
	if err != nil {
		return CustomApp{}, "", err
	}
	body, err := os.ReadFile(filepath.Join(s.appDir(id), app.Entry))
	if err != nil {
		return CustomApp{}, "", fmt.Errorf("app: read entry: %w", err)
	}
	if got := customAppContentHash(string(body)); app.ContentHash != "" && got != app.ContentHash {
		return CustomApp{}, "", fmt.Errorf("app: corrupt entry hash for %s", id)
	}
	return app, string(body), nil
}

func (s *customAppStore) readManifestLocked(id string) (CustomApp, error) {
	raw, err := os.ReadFile(filepath.Join(s.appDir(id), customAppManifestFile))
	if err != nil {
		return CustomApp{}, fmt.Errorf("app: read manifest: %w", err)
	}
	if err := rejectDuplicateTopLevelJSONFields(raw); err != nil {
		return CustomApp{}, fmt.Errorf("app: decode manifest: %w", err)
	}
	var app CustomApp
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&app); err != nil {
		return CustomApp{}, fmt.Errorf("app: decode manifest: %w", err)
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return CustomApp{}, fmt.Errorf("app: decode manifest: %w", err)
	}
	if app.ID != id {
		return CustomApp{}, fmt.Errorf("app: manifest id mismatch")
	}
	if err := validateCustomAppManifest(app); err != nil {
		return CustomApp{}, err
	}
	return app, nil
}

// Save creates a new app (empty req.ID) or updates an existing one.
//
// When the request carries source Files (the normal App Builder path), the HOST
// owns the bundle: it overwrites the protected host-contract files with their
// canonical embedded bytes, writes the source, builds it server-side
// (`bun install` + `bun run build`), and stores the BROKER-built
// dist/index.html — the agent-submitted html is ignored, so a generated app can
// never ship a tampered bridge or an unverified bundle. A build failure does NOT
// publish; it returns a caller error carrying the build output tail.
//
// When there are no source Files (an html-only registration, e.g. a built-in or
// simple app), it falls back to the submitted html as before.
func (s *customAppStore) Save(req CustomAppWriteRequest, now time.Time) (CustomApp, error) {
	return s.save(req, now, false)
}

// save implements Save. Callers that already hold the app's publish lock use
// publishLocked=true so compound manifest operations such as Rollback remain
// serialized without recursively locking the same mutex.
func (s *customAppStore) save(req CustomAppWriteRequest, now time.Time, publishLocked bool) (CustomApp, error) {
	name := strings.TrimSpace(req.Name)
	if name == "" {
		return CustomApp{}, newCustomAppCallerError("app: name is required")
	}
	if len(name) > customAppMaxNameBytes {
		return CustomApp{}, newCustomAppCallerError("app: name exceeds %d bytes", customAppMaxNameBytes)
	}
	if strings.ContainsRune(name, '\x00') {
		return CustomApp{}, newCustomAppCallerError("app: name must not contain NUL bytes")
	}
	actor := strings.TrimSpace(req.Actor)
	if actor == "" {
		actor = "app-builder"
	}
	icon := strings.TrimSpace(req.Icon)
	if icon == "" {
		icon = customAppDefaultIcon
	}
	stamp := now.UTC().Format(time.RFC3339Nano)
	representation := customAppRepresentationHTML
	if strings.TrimSpace(req.OpenUI) != "" {
		representation = customAppRepresentationOpenUI
	}
	if representation == customAppRepresentationOpenUI && (strings.TrimSpace(req.HTML) != "" || len(req.Files) > 0) {
		return CustomApp{}, newCustomAppCallerError("app: openui cannot be combined with html or source files")
	}
	if representation == customAppRepresentationHTML && strings.TrimSpace(req.HTML) == "" && len(req.Files) == 0 {
		return CustomApp{}, newCustomAppCallerError("app: html or source files are required")
	}
	if representation == customAppRepresentationOpenUI {
		if err := validateCustomAppOpenUI(req.OpenUI); err != nil {
			return CustomApp{}, err
		}
	}

	// Updates take the per-app gate before reading the current manifest. This
	// makes expected_version a real compare-and-swap rather than an advisory
	// check and prevents two publishers from selecting the same next version.
	var pl *sync.Mutex
	if id := strings.TrimSpace(req.ID); id != "" {
		pl = s.publishLock(id)
		if !publishLocked {
			pl.Lock()
			defer pl.Unlock()
		}
	}

	// Phase 1 (store lock): resolve the target manifest + ensure the dir. Held
	// briefly — the multi-second build does NOT run under this lock, so listings
	// and reads are never starved by a publish.
	s.mu.Lock()
	app, err := s.resolveSaveManifestLocked(req, name, actor, icon, stamp)
	if err != nil {
		s.mu.Unlock()
		return CustomApp{}, err
	}
	dir := s.appDir(app.ID)
	if mkErr := os.MkdirAll(dir, 0o700); mkErr != nil {
		s.mu.Unlock()
		return CustomApp{}, fmt.Errorf("app: mkdir: %w", mkErr)
	}
	s.mu.Unlock()

	// Creates do not have an id until the manifest is resolved. Their timestamped
	// ids are unique, but take the gate before touching their directory anyway.
	if pl == nil {
		pl = s.publishLock(app.ID)
		pl.Lock()
		defer pl.Unlock()
	}

	// Phase 2 (no store lock): produce the html to publish. With source Files this
	// stages the source, overwrites the protected host-contract files with
	// canonical bytes, and builds server-side — restoring the prior source on a
	// build failure so a deliberately-broken publish can't leave tampered source
	// running in the live preview. Without Files it returns the submitted html.
	body := req.OpenUI
	if representation == customAppRepresentationHTML {
		body, err = s.resolvePublishHTML(dir, req)
		if err != nil {
			return CustomApp{}, err
		}
		if err := validateCustomAppHTML(body); err != nil {
			return CustomApp{}, err
		}
	}
	app.ContentHash = customAppContentHash(body)

	// Phase 3 (store lock): commit the published bytes + manifest + version
	// snapshot atomically with respect to other store operations.
	s.mu.Lock()
	defer s.mu.Unlock()
	// Stage the immutable version first. The manifest is the final commit point;
	// a crash before it leaves at worst an orphan snapshot. Same-representation
	// body writes are hash-checked by Get so a partial commit fails closed.
	if err := s.snapshotVersionLocked(dir, app, body); err != nil {
		return CustomApp{}, err
	}
	if err := writeFileAtomic(filepath.Join(dir, app.Entry), []byte(body), 0o600); err != nil {
		return CustomApp{}, fmt.Errorf("app: write entry: %w", err)
	}
	manifestBytes, err := json.MarshalIndent(app, "", "  ")
	if err != nil {
		return CustomApp{}, fmt.Errorf("app: marshal manifest: %w", err)
	}
	manifestBytes = append(manifestBytes, '\n')
	if err := writeFileAtomic(filepath.Join(dir, customAppManifestFile), manifestBytes, 0o600); err != nil {
		return CustomApp{}, fmt.Errorf("app: write manifest: %w", err)
	}
	return app, nil
}

// resolveSaveManifestLocked builds the target manifest for a Save: an update
// reads + bumps the existing one, a create mints a fresh one. Must hold s.mu.
func (s *customAppStore) resolveSaveManifestLocked(req CustomAppWriteRequest, name, actor, icon, stamp string) (CustomApp, error) {
	representation := customAppRepresentationHTML
	if strings.TrimSpace(req.OpenUI) != "" {
		representation = customAppRepresentationOpenUI
	}
	var app CustomApp
	if id := strings.TrimSpace(req.ID); id != "" {
		if err := validateCustomAppID(id); err != nil {
			return CustomApp{}, err
		}
		existing, err := s.readManifestLocked(id)
		if err != nil {
			return CustomApp{}, newCustomAppCallerError("app: %s not found", id)
		}
		if req.ExpectedVersion == nil {
			return CustomApp{}, newCustomAppConflictError("app: expected_version is required when updating %s", id)
		}
		if *req.ExpectedVersion != existing.Version {
			return CustomApp{}, newCustomAppConflictError("app: expected v%d but current version is v%d", *req.ExpectedVersion, existing.Version)
		}
		app = existing
		app.Name = name
		app.Icon = icon
		app.Summary = strings.TrimSpace(req.Summary)
		if desc := strings.TrimSpace(req.Description); desc != "" {
			app.Description = desc
		}
		app.Version = existing.Version + 1
		app.UpdatedBy = actor
		app.UpdatedAt = stamp
	} else {
		slug := slugifyNotebookEntry(name)
		if slug == "" {
			slug = "app"
		}
		app = CustomApp{
			ID:             customAppID(slug, name, stamp),
			Slug:           slug,
			Name:           name,
			Icon:           icon,
			Summary:        strings.TrimSpace(req.Summary),
			Description:    strings.TrimSpace(req.Description),
			Entry:          customAppEntryForRepresentation(representation),
			Representation: representation,
			Version:        1,
			CreatedBy:      actor,
			UpdatedBy:      actor,
			CreatedAt:      stamp,
			UpdatedAt:      stamp,
		}
	}
	app.Representation = representation
	app.Entry = customAppEntryForRepresentation(representation)
	app.OpenUIVersion = ""
	app.OpenUILibrary = ""
	app.OpenUILibraryHash = ""
	app.ProviderVersion = ""
	if representation == customAppRepresentationOpenUI {
		app.OpenUIVersion = customAppOpenUIVersion
		app.OpenUILibrary = customAppOpenUILibrary
		app.OpenUILibraryHash = customAppOpenUILibraryHash
		app.ProviderVersion = customAppProviderVersion
	}
	// A register_app is always a real published build, so it clears the
	// "building" draft status a pre-scaffolded app carries.
	app.Status = customAppStatusReady
	return app, nil
}

// resolvePublishHTML produces the bytes to store as the app's html. When req
// carries source Files it is the HOST-built bundle: protected host-contract files
// are overwritten with canonical embedded bytes, the source is persisted, and
// `bun install` + `bun run build` produces dist/index.html — the agent's req.HTML
// is discarded. Without Files it returns req.HTML unchanged (html-only fallback).
//
// It is called WITHOUT the store mutex (so the build never starves reads) but
// UNDER the per-app publish lock (so the src/ dir has a single writer). On a
// build failure it RESTORES the prior source, so a deliberately-broken publish
// cannot leave tampered source running in the live dev preview.
func (s *customAppStore) resolvePublishHTML(dir string, req CustomAppWriteRequest) (string, error) {
	if len(req.Files) == 0 {
		// html-only registration: no source project, trust the submitted html
		// (the sandbox policy still gates it in the caller).
		return req.HTML, nil
	}
	// Deterministic App Builder harness, BEFORE staging/building: reject a publish
	// that (a) re-runs work on tab focus or polls tighter than the floor, or
	// (b) abandons the fixed Mantine kit. AI_RULES advises these; this ENFORCES
	// them so a token-burner or off-stack app can never reach the sealed bundle.
	// The agent reads the file:line list and republishes.
	violations := checkAppSourceEfficiency(req.Files)
	violations = append(violations, checkAppStackConformance(req.Files)...)
	violations = append(violations, checkAppThemeDepth(req.Files)...)
	violations = append(violations, checkAppCardPile(req.Files)...)
	if len(violations) > 0 {
		return "", appEfficiencyGuardError(violations)
	}
	// The host owns the contract: discard the agent's protected files and replace
	// them with the canonical embedded versions before anything is persisted or
	// built.
	files, err := overwriteProtectedFiles(req.Files)
	if err != nil {
		return "", err
	}

	srcRoot := filepath.Join(dir, customAppSourceDir)
	// Snapshot the prior app-source so a failed build rolls back to it (the live
	// preview keeps running the last good source, not the tampered one).
	restore, cleanup, err := snapshotAppSource(srcRoot)
	if err != nil {
		return "", err
	}
	defer cleanup()

	if err := s.writeAppSource(srcRoot, files); err != nil {
		return "", err
	}

	build := s.buildBundle
	if build == nil {
		build = buildAppBundle
	}
	built, buildErr := build(srcRoot)
	if buildErr != nil {
		// Roll the source back to the last good state before surfacing the error.
		// Wrap both so the build failure stays a caller error (4xx) while the
		// restore failure rides along in the chain.
		if rerr := restore(); rerr != nil {
			return "", fmt.Errorf("%w (and restoring prior source failed: %w)", buildErr, rerr)
		}
		return "", buildErr
	}
	return string(built), nil
}

// scaffoldPlaceholderHTML is the sealed entry written for a not-yet-built app so
// the sealed view (and get_app) has a valid document before the first publish.
// The live preview never uses it — it boots the dev server on the source below.
const scaffoldPlaceholderHTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
	`<meta name="viewport" content="width=device-width, initial-scale=1">` +
	`<title>Building…</title></head><body style="font:14px system-ui;padding:2rem;color:#555">` +
	`<p>This app is being built. The live preview shows progress as it is created.</p>` +
	`</body></html>`

const scaffoldPlaceholderOpenUI = `root = App("Preparing your app", [
  Callout("App Builder is generating this OpenUI app now.", "info")
])`

// SetEditChannel stamps the app's persistent edit-thread channel onto its
// manifest, idempotently. It is the one mutation the broker performs on an app
// it did NOT just build: when an App Builder task mints its `task-<id>` channel,
// the broker records that slug here so the FE can later bind the per-app edit
// chat to it. A no-op when the channel is already set to the same value (a
// retried create) so it never churns the manifest or bumps anything.
//
// Unknown id → caller error (404 upstream). Never touches Version/Status/bytes.
func (s *customAppStore) SetEditChannel(id, channel string) error {
	if err := validateCustomAppID(id); err != nil {
		return err
	}
	channel = strings.TrimSpace(channel)
	if channel == "" {
		return newCustomAppCallerError("app: edit channel is required")
	}
	pl := s.publishLock(id)
	pl.Lock()
	defer pl.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	app, err := s.readManifestLocked(id)
	if err != nil {
		return newCustomAppCallerError("app: %s not found", id)
	}
	if app.EditChannel == channel {
		return nil
	}
	app.EditChannel = channel
	manifestBytes, err := json.MarshalIndent(app, "", "  ")
	if err != nil {
		return fmt.Errorf("app: marshal manifest: %w", err)
	}
	manifestBytes = append(manifestBytes, '\n')
	if err := writeFileAtomic(filepath.Join(s.appDir(id), customAppManifestFile), manifestBytes, 0o600); err != nil {
		return fmt.Errorf("app: write manifest: %w", err)
	}
	return nil
}

// Rename updates an app's display name in place — the narrow metadata mutation
// behind PATCH /apps/{id}. It touches Name/UpdatedBy/UpdatedAt only: no version
// bump, no snapshot, no bytes — a rename is not a build. Deliberately NOT a
// generic update. Safe because nothing derives storage keys from Name: the app
// dir is keyed by ID, the manifest Slug is minted once at create and never
// recomputed, and operatorAppWorkflowKey slugs from the app ID.
//
// Validation mirrors Save: trimmed, non-empty, <= customAppMaxNameBytes, no NUL
// bytes (caller errors → 400 upstream). An unknown id surfaces the underlying
// os.ErrNotExist from the manifest read so writeAppError maps it to 404.
func (s *customAppStore) Rename(id, name, actor string, now time.Time) (CustomApp, error) {
	if err := validateCustomAppID(id); err != nil {
		return CustomApp{}, err
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return CustomApp{}, newCustomAppCallerError("app: name is required")
	}
	if len(name) > customAppMaxNameBytes {
		return CustomApp{}, newCustomAppCallerError("app: name exceeds %d bytes", customAppMaxNameBytes)
	}
	if strings.ContainsRune(name, '\x00') {
		return CustomApp{}, newCustomAppCallerError("app: name must not contain NUL bytes")
	}
	pl := s.publishLock(id)
	pl.Lock()
	defer pl.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	app, err := s.readManifestLocked(id)
	if err != nil {
		return CustomApp{}, err
	}
	if app.Name == name {
		// A no-op rename (retried PATCH) never churns the manifest or stamps.
		return app, nil
	}
	app.Name = name
	if trimmedActor := strings.TrimSpace(actor); trimmedActor != "" {
		app.UpdatedBy = trimmedActor
	}
	app.UpdatedAt = now.UTC().Format(time.RFC3339Nano)
	manifestBytes, err := json.MarshalIndent(app, "", "  ")
	if err != nil {
		return CustomApp{}, fmt.Errorf("app: marshal manifest: %w", err)
	}
	manifestBytes = append(manifestBytes, '\n')
	if err := writeFileAtomic(filepath.Join(s.appDir(id), customAppManifestFile), manifestBytes, 0o600); err != nil {
		return CustomApp{}, fmt.Errorf("app: write manifest: %w", err)
	}
	return app, nil
}

// Scaffold materializes a brand-new app's editable source from the embedded
// starter template and records a "building" draft manifest, BEFORE the App
// Builder writes a single line of code. The live preview can then boot a real
// dev server on this source in seconds — turning the old multi-minute
// "Building…" dead air into an instant, running scaffold the human watches the
// agent shape. The agent publishes the finished build with register_app(app_id)
// using this same id, which flips the draft to a ready, listed app.
//
// Scaffold is idempotent: if the id already exists (draft or published) it
// returns the existing manifest untouched, so a retried/duplicate task create
// never clobbers in-flight work.
func (s *customAppStore) Scaffold(id, name, icon, actor string, now time.Time) (CustomApp, error) {
	if err := validateCustomAppID(id); err != nil {
		return CustomApp{}, err
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return CustomApp{}, newCustomAppCallerError("app: name is required")
	}
	if len(name) > customAppMaxNameBytes {
		return CustomApp{}, newCustomAppCallerError("app: name exceeds %d bytes", customAppMaxNameBytes)
	}
	if strings.ContainsRune(name, '\x00') {
		return CustomApp{}, newCustomAppCallerError("app: name must not contain NUL bytes")
	}
	actor = strings.TrimSpace(actor)
	if actor == "" {
		actor = "app-builder"
	}
	icon = strings.TrimSpace(icon)
	if icon == "" {
		icon = customAppDefaultIcon
	}
	slug := slugifyNotebookEntry(name)
	if slug == "" {
		slug = "app"
	}
	stamp := now.UTC().Format(time.RFC3339Nano)

	pl := s.publishLock(id)
	pl.Lock()
	defer pl.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()

	if existing, err := s.readManifestLocked(id); err == nil {
		return existing, nil
	}

	app := CustomApp{
		ID:                id,
		Slug:              slug,
		Name:              name,
		Icon:              icon,
		Entry:             customAppOpenUIEntry,
		Representation:    customAppRepresentationOpenUI,
		OpenUIVersion:     customAppOpenUIVersion,
		OpenUILibrary:     customAppOpenUILibrary,
		OpenUILibraryHash: customAppOpenUILibraryHash,
		ProviderVersion:   customAppProviderVersion,
		Version:           0,
		Status:            customAppStatusBuilding,
		CreatedBy:         actor,
		UpdatedBy:         actor,
		CreatedAt:         stamp,
		UpdatedAt:         stamp,
	}
	dir := s.appDir(app.ID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return CustomApp{}, fmt.Errorf("app: mkdir: %w", err)
	}
	if err := writeFileAtomic(filepath.Join(dir, customAppOpenUIEntry), []byte(scaffoldPlaceholderOpenUI), 0o600); err != nil {
		return CustomApp{}, fmt.Errorf("app: write placeholder: %w", err)
	}
	manifestBytes, err := json.MarshalIndent(app, "", "  ")
	if err != nil {
		return CustomApp{}, fmt.Errorf("app: marshal manifest: %w", err)
	}
	manifestBytes = append(manifestBytes, '\n')
	if err := writeFileAtomic(filepath.Join(dir, customAppManifestFile), manifestBytes, 0o600); err != nil {
		return CustomApp{}, fmt.Errorf("app: write manifest: %w", err)
	}
	return app, nil
}

// writeScaffoldSourceLocked copies the embedded starter template into srcRoot,
// stripping the "app-scaffold/" prefix so package.json/vite.config/index.html
// land at the project root (srcRoot) and the app's own code under srcRoot/src.
func writeScaffoldSourceLocked(srcRoot string) error {
	return fs.WalkDir(templates.AppScaffold, templates.AppScaffoldRoot, func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(templates.AppScaffoldRoot, p)
		if err != nil {
			return err
		}
		body, err := templates.AppScaffold.ReadFile(p)
		if err != nil {
			return err
		}
		full := filepath.Join(srcRoot, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0o700); err != nil {
			return fmt.Errorf("app: mkdir scaffold dir: %w", err)
		}
		if err := writeFileAtomic(full, body, 0o600); err != nil {
			return fmt.Errorf("app: write scaffold file %q: %w", rel, err)
		}
		return nil
	})
}

func (s *customAppStore) snapshotVersionLocked(dir string, app CustomApp, body string) error {
	if app.Version < 1 {
		return nil
	}
	vdir := filepath.Join(dir, customAppVersionsDir, fmt.Sprintf("v%d", app.Version))
	if err := os.MkdirAll(vdir, 0o700); err != nil {
		return fmt.Errorf("app: mkdir version: %w", err)
	}
	if err := writeFileAtomic(filepath.Join(vdir, app.Entry), []byte(body), 0o600); err != nil {
		return fmt.Errorf("app: write version snapshot: %w", err)
	}
	// Capture who/when beside the bytes so the history timeline can label each
	// build. Versions snapshotted before this file existed degrade gracefully to
	// a bare version number (readVersionMetaLocked returns ok=false).
	meta := customAppVersionMeta{
		Version: app.Version, UpdatedAt: app.UpdatedAt, UpdatedBy: app.UpdatedBy,
		Representation: customAppRepresentation(app), Entry: app.Entry,
		OpenUIVersion: app.OpenUIVersion, OpenUILibrary: app.OpenUILibrary,
		OpenUILibraryHash: app.OpenUILibraryHash, ProviderVersion: app.ProviderVersion,
		ContentHash: app.ContentHash,
	}
	metaBytes, err := json.Marshal(meta)
	if err != nil {
		return fmt.Errorf("app: marshal version meta: %w", err)
	}
	if err := writeFileAtomic(filepath.Join(vdir, customAppVersionMetaFile), metaBytes, 0o600); err != nil {
		return fmt.Errorf("app: write version meta: %w", err)
	}
	return nil
}

// writeAppSource replaces src/ with the provided files (so deletes propagate).
// Each path is sanitized against traversal and build-tool config injection;
// build artifacts are rejected. A nil/empty map leaves any existing source
// untouched. Runs under the per-app publish lock (single writer of srcRoot), not
// the store mutex.
func (s *customAppStore) writeAppSource(srcRoot string, files map[string]string) error {
	if len(files) == 0 {
		return nil
	}
	if len(files) > customAppMaxSourceFiles {
		return newCustomAppCallerError("app: too many source files (%d > %d)", len(files), customAppMaxSourceFiles)
	}
	if err := clearSourceExceptArtifacts(srcRoot); err != nil {
		return fmt.Errorf("app: clear source: %w", err)
	}
	for rel, content := range files {
		clean, err := sanitizeAppSourcePath(rel)
		if err != nil {
			return err
		}
		if len(content) > customAppMaxSourceFileBytes {
			return newCustomAppCallerError("app: source file %q exceeds %d bytes", rel, customAppMaxSourceFileBytes)
		}
		full := filepath.Join(srcRoot, clean)
		if err := os.MkdirAll(filepath.Dir(full), 0o700); err != nil {
			return fmt.Errorf("app: mkdir source dir: %w", err)
		}
		if err := writeFileAtomic(full, []byte(content), 0o600); err != nil {
			return fmt.Errorf("app: write source: %w", err)
		}
	}
	return nil
}

// clearSourceExceptArtifacts removes every top-level entry under src/
// EXCEPT the preserved build/install artifacts (node_modules/, dist/, .vite/).
// Replacing the source this way (instead of os.RemoveAll on the whole tree)
// lets a publish land new source while a live dev server keeps running on the
// same node_modules — Vite then hot-reloads the change rather than crashing on
// a deleted dependency tree. Source deletes still propagate because every
// non-preserved entry (including the app's own nested src/ dir) is removed and
// rewritten from the new file set.
func clearSourceExceptArtifacts(srcRoot string) error {
	entries, err := os.ReadDir(srcRoot)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	for _, e := range entries {
		if customAppPreservedSrcDirs[e.Name()] {
			continue
		}
		if err := os.RemoveAll(filepath.Join(srcRoot, e.Name())); err != nil {
			return err
		}
	}
	return nil
}

// blockedAppSourceBasenames are build-tool config files an app must never carry.
// They change the SERVER-SIDE build environment, not the app: .npmrc/.bunfig.toml
// redirect the registry the host's `bun install` resolves from (a supply-chain
// vector), and .env* files are read by Vite and inlined into the bundle as
// import.meta.env.VITE_*. The host owns the build config; the agent ships app
// source only.
var blockedAppSourceBasenames = map[string]bool{
	".npmrc":           true,
	".bunfig.toml":     true,
	".yarnrc":          true,
	".yarnrc.yml":      true,
	".env":             true,
	".env.local":       true,
	".env.development": true,
	".env.production":  true,
}

// sanitizeAppSourcePath returns a cleaned relative path under src/, or a caller
// error if it would escape the app dir, names a build artifact, or names a
// build-tool config file that would tamper with the server-side build.
func sanitizeAppSourcePath(rel string) (string, error) {
	rel = filepath.ToSlash(strings.TrimSpace(rel))
	if rel == "" {
		return "", newCustomAppCallerError("app: empty source path")
	}
	if strings.HasPrefix(rel, "/") || strings.Contains(rel, "..") || strings.ContainsRune(rel, '\x00') {
		return "", newCustomAppCallerError("app: invalid source path %q", rel)
	}
	clean := filepath.Clean(rel)
	if clean == "." || filepath.IsAbs(clean) || strings.HasPrefix(filepath.ToSlash(clean), "../") {
		return "", newCustomAppCallerError("app: invalid source path %q", rel)
	}
	switch first := strings.SplitN(filepath.ToSlash(clean), "/", 2)[0]; first {
	case "node_modules", "dist", ".vite":
		return "", newCustomAppCallerError("app: source path %q is a build artifact; exclude node_modules, dist, and .vite", rel)
	}
	// Reject build-tool config by basename ANYWHERE in the tree — an .npmrc nested
	// under a subdir still affects the install run from the project root.
	base := strings.ToLower(filepath.Base(clean))
	if blockedAppSourceBasenames[base] || strings.HasPrefix(base, ".env.") {
		return "", newCustomAppCallerError("app: source path %q is a build-tool config; the host owns the build environment", rel)
	}
	return clean, nil
}

// Source returns the persisted source project (relative path -> content). Empty
// when an app has no source (html-only). Used by the App Builder via get_app.
func (s *customAppStore) Source(id string) (map[string]string, error) {
	if err := validateCustomAppID(id); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	srcRoot := filepath.Join(s.appDir(id), customAppSourceDir)
	out := map[string]string{}
	err := filepath.WalkDir(srcRoot, func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			if os.IsNotExist(walkErr) {
				return nil
			}
			return walkErr
		}
		if d.IsDir() {
			// Never read back preserved build/install artifacts as "source" —
			// node_modules would be thousands of files and is not the app.
			if p != srcRoot && customAppPreservedSrcDirs[d.Name()] {
				return fs.SkipDir
			}
			return nil
		}
		rel, err := filepath.Rel(srcRoot, p)
		if err != nil {
			return err
		}
		body, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		out[filepath.ToSlash(rel)] = string(body)
		return nil
	})
	if err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("app: read source: %w", err)
	}
	return out, nil
}

// CustomAppVersion is one retained build in an app's append-only history,
// surfaced by the version timeline. Metadata (who/when) is captured at snapshot
// time; builds snapshotted before that existed degrade to just the version
// number. Current marks the app's live build.
type CustomAppVersion struct {
	Version           int    `json:"version"`
	UpdatedAt         string `json:"updatedAt,omitempty"`
	UpdatedBy         string `json:"updatedBy,omitempty"`
	Current           bool   `json:"current"`
	Representation    string `json:"representation,omitempty"`
	Entry             string `json:"entry,omitempty"`
	OpenUIVersion     string `json:"openuiVersion,omitempty"`
	OpenUILibrary     string `json:"openuiLibrary,omitempty"`
	OpenUILibraryHash string `json:"openuiLibraryHash,omitempty"`
	ProviderVersion   string `json:"providerVersion,omitempty"`
	ContentHash       string `json:"contentHash,omitempty"`
}

// customAppVersionMeta is the on-disk metadata stored beside each retained build
// (versions/v<N>/meta.json). Current is intentionally NOT persisted — it is
// derived against the manifest at read time so it can never go stale.
type customAppVersionMeta struct {
	Version           int    `json:"version"`
	UpdatedAt         string `json:"updatedAt"`
	UpdatedBy         string `json:"updatedBy"`
	Representation    string `json:"representation,omitempty"`
	Entry             string `json:"entry,omitempty"`
	OpenUIVersion     string `json:"openuiVersion,omitempty"`
	OpenUILibrary     string `json:"openuiLibrary,omitempty"`
	OpenUILibraryHash string `json:"openuiLibraryHash,omitempty"`
	ProviderVersion   string `json:"providerVersion,omitempty"`
	ContentHash       string `json:"contentHash,omitempty"`
}

func applyCustomAppVersionMeta(ver *CustomAppVersion, meta customAppVersionMeta) {
	ver.UpdatedAt = meta.UpdatedAt
	ver.UpdatedBy = meta.UpdatedBy
	ver.Representation = meta.Representation
	ver.Entry = meta.Entry
	ver.OpenUIVersion = meta.OpenUIVersion
	ver.OpenUILibrary = meta.OpenUILibrary
	ver.OpenUILibraryHash = meta.OpenUILibraryHash
	ver.ProviderVersion = meta.ProviderVersion
	ver.ContentHash = meta.ContentHash
	if ver.Representation == "" {
		ver.Representation = customAppRepresentationHTML
		ver.Entry = customAppEntry
	}
}

// ListVersions returns the retained versions, newest first, each annotated with
// its capture metadata and whether it is the current build.
func (s *customAppStore) ListVersions(id string) ([]CustomAppVersion, error) {
	if err := validateCustomAppID(id); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	// Best-effort current version: a missing manifest just means nothing is
	// marked current (the versions dir read below still drives the list), so an
	// unknown/corrupt app degrades to an empty list rather than an error.
	var current int
	if app, err := s.readManifestLocked(id); err == nil {
		current = app.Version
	}
	dir := filepath.Join(s.appDir(id), customAppVersionsDir)
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return []CustomAppVersion{}, nil
		}
		return nil, fmt.Errorf("app: read versions: %w", err)
	}
	out := []CustomAppVersion{}
	for _, e := range entries {
		if !e.IsDir() || !strings.HasPrefix(e.Name(), "v") {
			continue
		}
		n, err := strconv.Atoi(strings.TrimPrefix(e.Name(), "v"))
		if err != nil || n < 1 {
			continue
		}
		ver := CustomAppVersion{Version: n, Current: n == current}
		if meta, ok := s.readVersionMetaLocked(dir, n); ok {
			applyCustomAppVersionMeta(&ver, meta)
		} else {
			ver.Representation = customAppRepresentationHTML
			ver.Entry = customAppEntry
		}
		out = append(out, ver)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Version > out[j].Version })
	return out, nil
}

// GetVersion returns a retained build's bytes plus its metadata WITHOUT changing
// the current version — the non-destructive read behind the timeline's preview.
// Restoring is the separate, explicit Rollback.
func (s *customAppStore) GetVersion(id string, version int) (CustomAppVersion, string, error) {
	if err := validateCustomAppID(id); err != nil {
		return CustomAppVersion{}, "", err
	}
	if version < 1 {
		return CustomAppVersion{}, "", newCustomAppCallerError("app: invalid version %d", version)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	versionsDir := filepath.Join(s.appDir(id), customAppVersionsDir)
	meta, ok := s.readVersionMetaLocked(versionsDir, version)
	entry := customAppEntry
	if ok && meta.Entry != "" {
		entry = meta.Entry
	}
	body, err := os.ReadFile(filepath.Join(versionsDir, fmt.Sprintf("v%d", version), entry))
	if err != nil {
		if os.IsNotExist(err) {
			return CustomAppVersion{}, "", newCustomAppCallerError("app: version v%d not found", version)
		}
		return CustomAppVersion{}, "", fmt.Errorf("app: read version: %w", err)
	}
	if ok && meta.ContentHash != "" && customAppContentHash(string(body)) != meta.ContentHash {
		return CustomAppVersion{}, "", fmt.Errorf("app: corrupt version v%d content hash", version)
	}
	ver := CustomAppVersion{Version: version}
	if app, err := s.readManifestLocked(id); err == nil {
		ver.Current = version == app.Version
	}
	if ok {
		applyCustomAppVersionMeta(&ver, meta)
	} else {
		ver.Representation = customAppRepresentationHTML
		ver.Entry = customAppEntry
	}
	return ver, string(body), nil
}

// readVersionMetaLocked reads versions/v<N>/meta.json. ok=false (not an error)
// when the file is absent or unparseable, so legacy snapshots degrade quietly.
func (s *customAppStore) readVersionMetaLocked(versionsDir string, version int) (customAppVersionMeta, bool) {
	raw, err := os.ReadFile(filepath.Join(versionsDir, fmt.Sprintf("v%d", version), customAppVersionMetaFile))
	if err != nil {
		return customAppVersionMeta{}, false
	}
	var meta customAppVersionMeta
	if err := json.Unmarshal(raw, &meta); err != nil {
		return customAppVersionMeta{}, false
	}
	representation := meta.Representation
	if representation == "" {
		representation = customAppRepresentationHTML
	}
	if err := validateCustomAppManifest(CustomApp{
		Entry:             meta.Entry,
		Representation:    representation,
		OpenUIVersion:     meta.OpenUIVersion,
		OpenUILibrary:     meta.OpenUILibrary,
		OpenUILibraryHash: meta.OpenUILibraryHash,
		ProviderVersion:   meta.ProviderVersion,
	}); err != nil {
		// Legacy metadata did not record an entry; normalize only that exact shape.
		if representation != customAppRepresentationHTML || meta.Entry != "" {
			return customAppVersionMeta{}, false
		}
		meta.Entry = customAppEntry
	}
	return meta, true
}

// Rollback restores a prior version's built bytes as a NEW forward version.
// History stays append-only, so a rollback is itself reversible.
func (s *customAppStore) Rollback(id string, version int, actor string, now time.Time) (CustomApp, error) {
	if err := validateCustomAppID(id); err != nil {
		return CustomApp{}, err
	}
	if version < 1 {
		return CustomApp{}, newCustomAppCallerError("app: invalid version %d", version)
	}
	pl := s.publishLock(id)
	pl.Lock()
	defer pl.Unlock()
	s.mu.Lock()
	app, err := s.readManifestLocked(id)
	if err != nil {
		s.mu.Unlock()
		return CustomApp{}, newCustomAppCallerError("app: %s not found", id)
	}
	if version == app.Version {
		s.mu.Unlock()
		return CustomApp{}, newCustomAppCallerError("app: v%d is already current", version)
	}
	s.mu.Unlock()
	// Reuse the version read path so rollback verifies the immutable snapshot's
	// content hash before those bytes can be republished as a new version.
	ver, body, readErr := s.GetVersion(id, version)
	if readErr != nil {
		return CustomApp{}, readErr
	}
	// save snapshots the restored bytes as a new version while retaining the
	// publish lock acquired above, so metadata cannot change between this read
	// and the forward-version commit.
	req := CustomAppWriteRequest{
		ID:              id,
		Name:            app.Name,
		Icon:            app.Icon,
		Summary:         app.Summary,
		Description:     app.Description,
		Actor:           actor,
		ExpectedVersion: &app.Version,
	}
	if ver.Representation == customAppRepresentationOpenUI {
		req.OpenUI = body
	} else {
		req.HTML = body
	}
	return s.save(req, now, true)
}

// validateCustomAppHTML enforces the app sandbox policy at write time. It is
// intentionally close to validateRichArtifactSandboxPolicy but permits <form>.
func validateCustomAppHTML(raw string) error {
	if strings.TrimSpace(raw) == "" {
		return newCustomAppCallerError("app: html is required")
	}
	if len([]byte(raw)) > customAppMaxHTMLBytes {
		return newCustomAppCallerError("app: html exceeds %d bytes", customAppMaxHTMLBytes)
	}
	if strings.ContainsRune(raw, '\x00') {
		return newCustomAppCallerError("app: html must not contain NUL bytes")
	}
	return validateSandboxHTML(raw, sandboxHTMLPolicy{
		label:          "app",
		blockedElement: customAppBlockedElementReason,
		newErr:         newCustomAppCallerError,
	})
}

var customAppOpenUIToolCallRE = regexp.MustCompile(`\b(Query|Mutation)\s*\(\s*"([a-z0-9_]+)"`)
var customAppOpenUIRootRE = regexp.MustCompile(`(?m)^\s*root\s*=\s*App\s*\(`)
var customAppOpenUIForbiddenActionRE = regexp.MustCompile(`(?i)@(?:OpenUrl|ToAssistant)\s*\(`)
var customAppOpenUIURLRE = regexp.MustCompile(`(?i)https?://`)
var customAppOpenUIStringRE = regexp.MustCompile(`"(?:\\.|[^"\\])*"`)
var customAppOpenUICallRE = regexp.MustCompile(`\b(?:Query|Mutation)\s*\(`)
var customAppOpenUIMutationStatementRE = regexp.MustCompile(`(?m)^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*Mutation\s*\(`)
var customAppOpenUIFastRefreshRE = regexp.MustCompile(`(?m)Query\s*\([^\n]*,\s*(?:[0-9]|1[0-4])(?:\.\d+)?\s*\)`)

var customAppOpenUIQueryTools = map[string]bool{
	"wuphf_list_tasks":          true,
	"wuphf_list_office_members": true,
	"wuphf_list_channels":       true,
	"wuphf_list_requests":       true,
	"wuphf_wiki_list":           true,
	"wuphf_wiki_read":           true,
	"wuphf_list_integrations":   true,
	"wuphf_app_db_query":        true,
}

var customAppOpenUIMutationTools = map[string]bool{
	"wuphf_create_task":      true,
	"wuphf_call_integration": true,
	"wuphf_app_db_define":    true,
	"wuphf_app_db_upsert":    true,
	"wuphf_app_db_clear":     true,
}

// validateCustomAppOpenUI is the server-side publication gate. The browser
// repeats full schema/parser validation before render; this gate independently
// prevents mixed formats, dynamic tool selection, unreviewed host actions, and
// documents large enough to exhaust the renderer.
func validateCustomAppOpenUI(raw string) error {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return newCustomAppCallerError("app: openui is required")
	}
	if len([]byte(raw)) > customAppMaxOpenUIBytes {
		return newCustomAppCallerError("app: openui exceeds %d bytes", customAppMaxOpenUIBytes)
	}
	if strings.ContainsRune(raw, '\x00') {
		return newCustomAppCallerError("app: openui must not contain NUL bytes")
	}
	if err := validateCustomAppOpenUIStructure(raw); err != nil {
		return err
	}
	if !customAppOpenUIRootRE.MatchString(raw) {
		return newCustomAppCallerError("app: openui must define root = App(...)")
	}
	if customAppOpenUIForbiddenActionRE.MatchString(raw) || customAppOpenUIURLRE.MatchString(raw) {
		return newCustomAppCallerError("app: openui contains a forbidden host action or URL")
	}
	if len(strings.Split(raw, "\n")) > 512 {
		return newCustomAppCallerError("app: openui exceeds the statement budget")
	}
	matches := customAppOpenUIToolCallRE.FindAllStringSubmatch(raw, -1)
	active := customAppOpenUIStringRE.ReplaceAllString(raw, `""`)
	callCount := len(customAppOpenUICallRE.FindAllString(active, -1))
	if callCount != len(matches) {
		return newCustomAppCallerError("app: every Query and Mutation must use a literal allowed tool name")
	}
	if callCount > 12 {
		return newCustomAppCallerError("app: openui exceeds the active tool budget")
	}
	for _, match := range matches {
		kind, name := match[1], match[2]
		if kind == "Query" && !customAppOpenUIQueryTools[name] {
			return newCustomAppCallerError("app: query tool %q is not allowed", name)
		}
		if kind == "Mutation" && !customAppOpenUIMutationTools[name] {
			return newCustomAppCallerError("app: mutation tool %q is not allowed", name)
		}
	}
	for _, match := range customAppOpenUIMutationStatementRE.FindAllStringSubmatch(raw, -1) {
		run := regexp.MustCompile(`@Run\s*\(\s*` + regexp.QuoteMeta(match[1]) + `\s*\)`)
		if !run.MatchString(raw) {
			return newCustomAppCallerError("app: mutation %q must be bound to an explicit @Run action", match[1])
		}
	}
	if customAppOpenUIFastRefreshRE.MatchString(raw) {
		return newCustomAppCallerError("app: query refresh must be at least 15 seconds")
	}
	return nil
}

func customAppBlockedElementReason(tag string) (string, bool) {
	switch tag {
	case "base":
		return "base URLs can rewrite link targets inside the sandbox", true
	case "embed", "iframe", "object":
		return "nested browsing contexts and plugins are not part of the app sandbox", true
	case "link":
		return "external stylesheets and preloads are not allowed; inline your styles", true
	default:
		// NB: <form> is intentionally allowed — it is inert under the app
		// sandbox (no allow-forms / allow-same-origin) and real tools use it.
		return "", false
	}
}
