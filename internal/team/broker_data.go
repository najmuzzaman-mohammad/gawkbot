package team

// broker_data.go owns the HTTP surface for DATA SPACES — the structured
// datastores bots build for themselves (object types, attributes,
// relationships, records). The wire shape is docs/specs/agent-data-model.md
// and is mirrored 1:1 by the MCP tools and by web/src/api/dataspacesClient.ts.
//
//	GET    /data/spaces                                  -> { spaces: [...] }
//	POST   /data/spaces                                  -> { space }
//	GET    /data/spaces/{space}                          -> Schema
//	PATCH  /data/spaces/{space}                          -> { space }
//	POST   /data/spaces/{space}/object-types             -> Result
//	PATCH  /data/spaces/{space}/object-types/{type}      -> { object_type }
//	POST   /data/spaces/{space}/object-types/{type}/attributes        -> Result
//	PATCH  /data/spaces/{space}/object-types/{type}/attributes/{attr} -> { attribute }
//	POST   /data/spaces/{space}/records/query            -> { records, total }
//	POST   /data/spaces/{space}/records                  -> Result
//	PUT    /data/spaces/{space}/records                  -> Result   (upsert)
//	GET    /data/spaces/{space}/records/{id}             -> { record }
//	PATCH  /data/spaces/{space}/records/{id}             -> { record }
//	POST   /data/spaces/{space}/links                    -> Result
//	POST   /data/spaces/{space}/unlinks                  -> Result
//	POST   /data/spaces/{space}/delete-preview           -> Preview
//	POST   /data/spaces/{space}/delete                   -> { impact }
//	POST   /data/spaces/{space}/apps/{appId}             -> { space }   (attach)
//	DELETE /data/spaces/{space}/apps/{appId}             -> { space }   (detach)
//
// Anything else under /data/ is a 404, so a typo never falls through to the
// SPA fallback and reads as an empty surface.
//
// ── ACTOR RESOLUTION (the security boundary) ─────────────────────────────
//
// Every Store call takes the calling dataspace.Actor and enforces access
// itself. Resolving that actor is therefore the only thing standing between
// one bot and another bot's private space. It FAILS CLOSED: a caller that
// cannot be positively identified gets no access at all, not the operator's.
//
// Three outcomes, in this order:
//
//   - X-WUPHF-Agent (botRateLimitHeader) names a bot. internal/teammcp's
//     authHeaders() sets it from WUPHF_AGENT_SLUG, which the LAUNCHER stamps
//     on the bot process. The same header already backs the per-bot rate
//     limiter and rich-artifact attribution.
//   - X-WUPHF-Operator carrying this process's dataOperatorKey is THE
//     OPERATOR. The key is minted per broker process in NewBrokerAt, lives
//     only in the Broker struct, and is stamped onto exactly one hop:
//     webUIProxyHandler, which runs inside this process, forwarding the web
//     UI's own /api traffic. Nothing writes it to disk, to the environment,
//     or to a command line, so — unlike the broker token — a bot cannot hold
//     it. Compared in constant time.
//   - Anything else is UNIDENTIFIED and gets dataspace.ErrForbidden. This is
//     the fix for the 2026-09-18 security finding: every bot holds
//     WUPHF_BROKER_TOKEN and WUPHF_BROKER_BASE_URL on its own command line
//     (prompts.go) and can run a shell, so "authenticated, no agent header"
//     used to mean "the operator, write on every space in the office" to any
//     bot that simply omitted a header. Enumerating forbidden identities
//     ("human", "you", …) could never have caught that, because omission
//     impersonates nobody. The denylist stays, but only as a second fence.
//
// Two rules that are ours, not inherited:
//
//   - The actor is NEVER read from a request body or query parameter. A
//     caller cannot name the bot it wants to be.
//   - The header may not claim the operator. dataspace.ActorHuman ("human")
//     and the other reserved identities are rejected outright.
//
// Known limitations, stated plainly because the previous version of this
// comment overstated the guarantees:
//
//   - The X-WUPHF-Agent header is asserted by a caller that already holds the
//     broker token, so any bot can set it to ANOTHER bot's slug. That is the
//     existing repo-wide trust boundary for bot identity (see the same header
//     in broker_rich_artifact.go and broker_middleware.go); closing it needs
//     per-bot credentials, which is a broker-wide change, not a /data one.
//     What is closed here is the escalation to the operator, which was
//     strictly worse: it needed no identity at all.
//   - A browser pointed STRAIGHT at the broker port (client.ts connectBroker
//     / the /web-token fallback, neither of which the shipped UI calls today)
//     never traverses webUIProxyHandler and is therefore unidentified on
//     /data. That is deliberate: the broker cannot tell such a request apart
//     from a bot's curl, since a bot can set Origin and Sec-Fetch-* freely
//     and can fetch /web-token over loopback itself.

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"sync"

	"github.com/nex-crm/wuphf/internal/dataspace"
)

// dataOperatorHeader carries the per-process operator key that
// webUIProxyHandler stamps on the web UI's own traffic. It is the ONLY thing
// that makes a caller the operator on /data.
const dataOperatorHeader = "X-WUPHF-Operator"

// dataRequestBodyLimit bounds a single /data request body. Records write up to
// 1000 items per call (the spec's limit), so the ceiling is higher than the
// app DB's 1 MiB while still being a hard stop.
const dataRequestBodyLimit = 8 << 20

// errDataStoreUnavailable is returned when no store implementation is wired.
var errDataStoreUnavailable = errors.New("data spaces are not available")

// newDataStore builds the space store rooted at root; an empty root means the
// package's own default (<runtime-home>/.wuphf/data, flat so that sharing a
// space or promoting it to global never moves its file). It is a package var
// so internal/dataspace plugs in from exactly one place
// (broker_data_store.go) and so a test can inject a fake without touching the
// broker constructor. Nil means "not wired" -> 503 rather than a panic.
var newDataStore func(root string) (dataspace.Store, error)

// dataStoreRootOverride points the store at a specific directory. Empty means
// the package default.
var dataStoreRootOverride string

// dataStoreOverrideMu guards the two package vars above against the tests that
// swap them.
var dataStoreOverrideMu sync.Mutex

// dataStore lazily opens the space store on first use, mirroring appStore().
//
// SUCCESS is memoized; FAILURE is not. A sync.Once here would cache the first
// error for the life of the process, so a home directory that was not mounted
// yet, a full disk, or a lock another process held for a second would take
// /data down until the broker restarted. The mutex is held across the open so
// two concurrent first requests cannot race two stores onto the same files.
func (b *Broker) dataStore() (dataspace.Store, error) {
	b.dataSpacesMu.Lock()
	defer b.dataSpacesMu.Unlock()
	if b.dataSpaces != nil {
		return b.dataSpaces, nil
	}
	dataStoreOverrideMu.Lock()
	factory, root := newDataStore, dataStoreRootOverride
	dataStoreOverrideMu.Unlock()
	if factory == nil {
		return nil, errDataStoreUnavailable
	}
	store, err := factory(root)
	if err != nil {
		return nil, err
	}
	if store == nil {
		// A factory that returns (nil, nil) would otherwise be retried on every
		// request forever while each handler nil-panics. Treat it as unwired.
		return nil, errDataStoreUnavailable
	}
	b.dataSpaces = store
	return store, nil
}

// ── Actor resolution ─────────────────────────────────────────────────────

// dataReservedActorSlugs are identities a bot header may never claim. "human"
// is the operator and would grant write on every space; the rest are the
// pseudo-senders the broker uses for non-bot traffic. This is a SECOND fence,
// not the boundary: a denylist can only catch a caller that names a forbidden
// identity, and the finding this file was hardened for named none at all.
var dataReservedActorSlugs = map[string]bool{
	string(dataspace.ActorHuman): true,
	"you":                        true,
	"system":                     true,
	"operator":                   true,
}

// errDataActorUnidentified is the fail-closed answer for a caller that holds
// the broker token but proves nothing about who it is. It unwraps to
// dataspace.ErrForbidden, so writeDataError answers 403 with this sentence.
var errDataActorUnidentified = &dataspace.ForbiddenError{
	Message: "this request did not identify its caller; data spaces are reachable by a bot (X-WUPHF-Agent) or by the operator's own workspace UI",
}

// requestIsOperator reports whether r came through THIS process's web UI
// proxy, which is the only caller allowed to speak as the operator on /data.
// Constant-time so the key cannot be recovered a byte at a time.
func (b *Broker) requestIsOperator(r *http.Request) bool {
	if r == nil || b.dataOperatorKey == "" {
		return false
	}
	presented := strings.TrimSpace(r.Header.Get(dataOperatorHeader))
	if presented == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(presented), []byte(b.dataOperatorKey)) == 1
}

// stampDataOperatorHeader marks an outbound proxy request as operator traffic.
// Called from webUIProxyHandler and nowhere else.
func (b *Broker) stampDataOperatorHeader(header http.Header) {
	if header == nil || b.dataOperatorKey == "" {
		return
	}
	header.Set(dataOperatorHeader, b.dataOperatorKey)
}

// dataActorFromRequest resolves who is calling. See the ACTOR RESOLUTION note
// at the top of this file. A bot slug comes from the launcher-stamped
// X-WUPHF-Agent header, the operator from the proxy-stamped operator key, and
// anything else is refused — "authenticated" is not "identified".
//
// The bot header is read FIRST so that a route the proxy legitimately relays
// a bot identity on (the App Builder writer path, /apps/{id}/data-space)
// keeps behaving exactly as it does today. On /data the proxy never relays
// that header at all, so operator traffic cannot be downgraded by it.
func (b *Broker) dataActorFromRequest(r *http.Request) (dataspace.Actor, error) {
	raw := strings.TrimSpace(r.Header.Get(botRateLimitHeader))
	if raw != "" {
		slug := strings.ToLower(raw)
		if !dataspace.IsBotSlug(slug) {
			return "", &dataspace.ValidationError{Message: "calling bot identity is not a valid slug"}
		}
		if dataReservedActorSlugs[slug] {
			return "", &dataspace.ValidationError{Message: "calling bot identity is reserved"}
		}
		return dataspace.Actor(slug), nil
	}
	if b.requestIsOperator(r) {
		return dataspace.ActorHuman, nil
	}
	return "", errDataActorUnidentified
}

// ── Errors ───────────────────────────────────────────────────────────────

// writeDataError maps a store error onto the documented status codes. The
// default arm deliberately returns a fixed sentence: an unexpected error may
// carry a file path or SQL text and neither belongs in a response body.
func writeDataError(w http.ResponseWriter, err error) {
	var forbidden *dataspace.ForbiddenError
	var invalid *dataspace.ValidationError
	switch {
	case errors.Is(err, dataspace.ErrNotFound):
		// Two different things reach here. A space the caller may not see
		// returns a BARE ErrNotFound and must stay opaque, or a bot could
		// probe for another bot's private spaces. An id that names nothing
		// INSIDE a space the caller can already read carries a message that
		// lets the caller correct itself ("Unknown object type "invstor".
		// Known object types: Investor, Firm, Meeting."), and swallowing that
		// for a bare "not found" is what makes a bot retry the same typo.
		if errors.As(err, &invalid) && invalid.Message != "" {
			body := map[string]string{"error": invalid.Message}
			if invalid.Attribute != "" {
				body["attribute"] = invalid.Attribute
			}
			writeJSON(w, http.StatusNotFound, body)
			return
		}
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
	case errors.As(err, &forbidden):
		writeJSON(w, http.StatusForbidden, map[string]string{"error": forbidden.Error()})
	case errors.As(err, &invalid):
		body := map[string]string{"error": invalid.Message}
		if invalid.Attribute != "" {
			body["attribute"] = invalid.Attribute
		}
		writeJSON(w, http.StatusBadRequest, body)
	case errors.Is(err, dataspace.ErrForbidden):
		writeJSON(w, http.StatusForbidden, map[string]string{"error": err.Error()})
	case errors.Is(err, errDataStoreUnavailable):
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "data spaces are not available"})
	default:
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "data store error"})
	}
}

func writeDataNotFound(w http.ResponseWriter) {
	writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
}

func writeDataMethodNotAllowed(w http.ResponseWriter) {
	writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
}

// decodeDataBody reads a bounded JSON body. An unreadable body is a caller
// error, never a 500.
func decodeDataBody(w http.ResponseWriter, r *http.Request, out any) bool {
	if r.Body == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "request body is required"})
		return false
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, dataRequestBodyLimit)).Decode(out); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return false
	}
	return true
}

// ── Rate limiting ────────────────────────────────────────────────────────

// consumeDataWriteBudget charges one data WRITE against the SAME rolling
// bucket map the app DB writes use (appDBWriteBuckets, 120/minute). Reusing
// it is deliberate: both surfaces exist to stop one looping caller from
// hammering a store under a mutex, and a second limiter would be a second
// thing to tune. The key is per-actor per-space so one bot's loop cannot
// starve another bot or the operator. Reads are unmetered.
func (b *Broker) consumeDataWriteBudget(actor dataspace.Actor, spaceID string) (retryAfter int, limited bool) {
	key := "data:" + string(actor) + ":" + spaceID
	wait, over := b.consumeAppDBWriteBudget(key)
	if !over {
		return 0, false
	}
	return int(wait.Seconds()) + 1, true
}

// dataMethodWrites reports whether this request mutates the store.
func dataMethodWrites(method string) bool {
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return true
	}
	return false
}

// ── Collection route ─────────────────────────────────────────────────────

type dataCreateSpaceRequest struct {
	Name        string            `json:"name"`
	Description string            `json:"description"`
	Access      *dataspace.Access `json:"access,omitempty"`
}

// handleDataSpaces owns GET|POST /data/spaces.
func (b *Broker) handleDataSpaces(w http.ResponseWriter, r *http.Request) {
	store, actor, ok := b.beginDataRequest(w, r, "")
	if !ok {
		return
	}
	switch r.Method {
	case http.MethodGet:
		spaces, err := store.ListSpaces(r.Context(), actor)
		if err != nil {
			writeDataError(w, err)
			return
		}
		if spaces == nil {
			spaces = []dataspace.Space{}
		}
		writeJSON(w, http.StatusOK, map[string]any{"spaces": spaces})
	case http.MethodPost:
		var body dataCreateSpaceRequest
		if !decodeDataBody(w, r, &body) {
			return
		}
		access := dataspace.Access{Scope: dataspace.ScopePrivate}
		if body.Access != nil {
			access = *body.Access
		}
		space, err := store.CreateSpace(r.Context(), actor, body.Name, body.Description, access)
		if err != nil {
			writeDataError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"space": space})
	default:
		writeDataMethodNotAllowed(w)
	}
}

// handleDataNotFound answers every unmatched path under /data/. Registered so
// a mistyped route is an honest 404 instead of reaching the SPA fallback.
func (b *Broker) handleDataNotFound(w http.ResponseWriter, _ *http.Request) {
	writeDataNotFound(w)
}

// beginDataRequest resolves the store, the actor, and the write budget for one
// request. It writes the response itself on failure; ok=false means the
// handler must return immediately.
func (b *Broker) beginDataRequest(w http.ResponseWriter, r *http.Request, spaceID string) (dataspace.Store, dataspace.Actor, bool) {
	store, err := b.dataStore()
	if err != nil {
		writeDataError(w, err)
		return nil, "", false
	}
	actor, err := b.dataActorFromRequest(r)
	if err != nil {
		// A caller that cannot be identified gets no bucket from
		// rateLimitMiddleware either — the per-bot bucket is keyed on the very
		// header this caller omitted, and the per-IP bucket is bypassed for
		// anyone holding the broker token. Charge the refusal here so a loop
		// of anonymous probes is cut off rather than answered forever.
		if errors.Is(err, dataspace.ErrForbidden) {
			if wait, over := b.consumeAppDBWriteBudget("data:unidentified:" + clientIPFromRequest(r)); over {
				w.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds())+1))
				writeJSON(w, http.StatusTooManyRequests, map[string]string{
					"error": "too many unidentified data requests — retry shortly",
				})
				return nil, "", false
			}
		}
		writeDataError(w, err)
		return nil, "", false
	}
	if dataMethodWrites(r.Method) {
		if retryAfter, limited := b.consumeDataWriteBudget(actor, spaceID); limited {
			w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
			writeJSON(w, http.StatusTooManyRequests, map[string]string{
				"error": "data write rate limit reached — retry shortly",
			})
			return nil, "", false
		}
	}
	return store, actor, true
}
