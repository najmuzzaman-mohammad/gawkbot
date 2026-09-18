package team

// broker_data_routes.go is the path dispatcher for everything under
// /data/spaces/{space}. It mirrors handleAppByID in broker_apps.go: split the
// remainder of the path, switch on the first sub-segment, and let each leaf
// handler own one verb set. Kept apart from broker_data.go so neither file
// grows past the repo's size budget.

import (
	"net/http"
	"strings"

	"github.com/nex-crm/wuphf/internal/dataspace"
)

// ── Request bodies ───────────────────────────────────────────────────────

type dataObjectTypesRequest struct {
	Items []dataspace.ObjectTypeInput `json:"items"`
}

type dataAttributesRequest struct {
	Items []dataspace.AttributeInput `json:"items"`
}

type dataRecordsRequest struct {
	ObjectType   string                  `json:"object_type"`
	MatchingAttr string                  `json:"matching_attribute"`
	Items        []dataspace.RecordInput `json:"items"`
}

type dataRecordPatchRequest struct {
	Values map[string]any `json:"values"`
}

type dataLinksRequest struct {
	Items []dataspace.LinkInput `json:"items"`
}

type dataDeletePreviewRequest struct {
	Kind dataspace.DeleteKind `json:"kind"`
	IDs  []string             `json:"ids"`
}

type dataDeleteRequest struct {
	Token string `json:"token"`
}

// ── Dispatch ─────────────────────────────────────────────────────────────

// handleDataSpaceSubpath owns /data/spaces/{space} and everything beneath it.
func (b *Broker) handleDataSpaceSubpath(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/data/spaces/"), "/")
	if rest == "" {
		// "/data/spaces/" with nothing after it is the collection route, which
		// has its own exact pattern; landing here means a trailing slash.
		b.handleDataSpaces(w, r)
		return
	}
	parts := strings.Split(rest, "/")
	spaceID := parts[0]
	sub := parts[1:]

	// The id shape is checked BEFORE anything downstream can key state on it.
	// A space id from the URL becomes a per-space mutex key and a rate-limit
	// key inside the store, so an unvalidated segment lets a caller mint
	// unbounded map entries with one request each. dataspace.IsSpaceID exists
	// for exactly this. The answer is the ordinary not-found: a well-formed id
	// the caller may not see returns the same thing, so the two are
	// indistinguishable and nothing is leaked by probing.
	if !dataspace.IsSpaceID(spaceID) {
		writeDataNotFound(w)
		return
	}

	store, actor, ok := b.beginDataRequest(w, r, spaceID)
	if !ok {
		return
	}

	if len(sub) == 0 {
		b.handleDataSpaceRoot(w, r, store, actor, spaceID)
		return
	}
	switch sub[0] {
	case "object-types":
		b.handleDataObjectTypes(w, r, store, actor, spaceID, sub[1:])
	case "records":
		b.handleDataRecords(w, r, store, actor, spaceID, sub[1:])
	case "links", "unlinks":
		b.handleDataLinks(w, r, store, actor, spaceID, sub[0] == "links", sub[1:])
	case "delete-preview":
		b.handleDataDeletePreview(w, r, store, actor, spaceID, sub[1:])
	case "delete":
		b.handleDataDelete(w, r, store, actor, spaceID, sub[1:])
	case "apps":
		b.handleDataApps(w, r, store, actor, spaceID, sub[1:])
	default:
		writeDataNotFound(w)
	}
}

// ── Space ────────────────────────────────────────────────────────────────

func (b *Broker) handleDataSpaceRoot(w http.ResponseWriter, r *http.Request, store dataspace.Store, actor dataspace.Actor, spaceID string) {
	switch r.Method {
	case http.MethodGet:
		schema, err := store.GetSchema(r.Context(), actor, spaceID)
		if err != nil {
			writeDataError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, schema)
	case http.MethodPatch:
		var patch dataspace.SpacePatch
		if !decodeDataBody(w, r, &patch) {
			return
		}
		space, err := store.UpdateSpace(r.Context(), actor, spaceID, patch)
		if err != nil {
			writeDataError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"space": space})
	default:
		writeDataMethodNotAllowed(w)
	}
}

// ── Object types and attributes ──────────────────────────────────────────

// handleDataObjectTypes owns:
//
//	POST  .../object-types
//	PATCH .../object-types/{type}
//	POST  .../object-types/{type}/attributes
//	PATCH .../object-types/{type}/attributes/{attr}
func (b *Broker) handleDataObjectTypes(w http.ResponseWriter, r *http.Request, store dataspace.Store, actor dataspace.Actor, spaceID string, rest []string) {
	switch len(rest) {
	case 0:
		if r.Method != http.MethodPost {
			writeDataMethodNotAllowed(w)
			return
		}
		var body dataObjectTypesRequest
		if !decodeDataBody(w, r, &body) {
			return
		}
		result, err := store.CreateObjectTypes(r.Context(), actor, spaceID, body.Items)
		if err != nil {
			writeDataError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
	case 1:
		if r.Method != http.MethodPatch {
			writeDataMethodNotAllowed(w)
			return
		}
		var patch dataspace.ObjectTypePatch
		if !decodeDataBody(w, r, &patch) {
			return
		}
		objectType, err := store.UpdateObjectType(r.Context(), actor, spaceID, rest[0], patch)
		if err != nil {
			writeDataError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"object_type": objectType})
	case 2:
		if rest[1] != "attributes" {
			writeDataNotFound(w)
			return
		}
		if r.Method != http.MethodPost {
			writeDataMethodNotAllowed(w)
			return
		}
		var body dataAttributesRequest
		if !decodeDataBody(w, r, &body) {
			return
		}
		result, err := store.AddAttributes(r.Context(), actor, spaceID, rest[0], body.Items)
		if err != nil {
			writeDataError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
	case 3:
		if rest[1] != "attributes" {
			writeDataNotFound(w)
			return
		}
		if r.Method != http.MethodPatch {
			writeDataMethodNotAllowed(w)
			return
		}
		var patch dataspace.AttributePatch
		if !decodeDataBody(w, r, &patch) {
			return
		}
		attribute, err := store.UpdateAttribute(r.Context(), actor, spaceID, rest[0], rest[2], patch)
		if err != nil {
			writeDataError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"attribute": attribute})
	default:
		writeDataNotFound(w)
	}
}

// ── Records ──────────────────────────────────────────────────────────────

// handleDataRecords owns:
//
//	POST  .../records            (create)
//	PUT   .../records            (upsert)
//	POST  .../records/query
//	GET   .../records/{id}
//	PATCH .../records/{id}
func (b *Broker) handleDataRecords(w http.ResponseWriter, r *http.Request, store dataspace.Store, actor dataspace.Actor, spaceID string, rest []string) {
	if len(rest) == 0 {
		var body dataRecordsRequest
		switch r.Method {
		case http.MethodPost:
			if !decodeDataBody(w, r, &body) {
				return
			}
			result, err := store.CreateRecords(r.Context(), actor, spaceID, body.ObjectType, body.Items)
			if err != nil {
				writeDataError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, result)
		case http.MethodPut:
			if !decodeDataBody(w, r, &body) {
				return
			}
			result, err := store.UpsertRecords(r.Context(), actor, spaceID, body.ObjectType, body.MatchingAttr, body.Items)
			if err != nil {
				writeDataError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, result)
		default:
			writeDataMethodNotAllowed(w)
		}
		return
	}
	if len(rest) > 1 {
		writeDataNotFound(w)
		return
	}
	// POST .../records/query is the query verb; every other single segment is
	// a record id. A record whose id really is "query" is still readable by
	// GET, because only POST is claimed here.
	if rest[0] == "query" && r.Method == http.MethodPost {
		var query dataspace.Query
		if !decodeDataBody(w, r, &query) {
			return
		}
		page, err := store.QueryRecords(r.Context(), actor, spaceID, query)
		if err != nil {
			writeDataError(w, err)
			return
		}
		if page.Records == nil {
			page.Records = []dataspace.Record{}
		}
		writeJSON(w, http.StatusOK, page)
		return
	}
	switch r.Method {
	case http.MethodGet:
		record, err := store.GetRecord(r.Context(), actor, spaceID, rest[0])
		if err != nil {
			writeDataError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"record": record})
	case http.MethodPatch:
		var body dataRecordPatchRequest
		if !decodeDataBody(w, r, &body) {
			return
		}
		record, err := store.UpdateRecord(r.Context(), actor, spaceID, rest[0], body.Values)
		if err != nil {
			writeDataError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"record": record})
	default:
		writeDataMethodNotAllowed(w)
	}
}

// ── Links ────────────────────────────────────────────────────────────────

func (b *Broker) handleDataLinks(w http.ResponseWriter, r *http.Request, store dataspace.Store, actor dataspace.Actor, spaceID string, link bool, rest []string) {
	if len(rest) > 0 {
		writeDataNotFound(w)
		return
	}
	if r.Method != http.MethodPost {
		writeDataMethodNotAllowed(w)
		return
	}
	var body dataLinksRequest
	if !decodeDataBody(w, r, &body) {
		return
	}
	var (
		result dataspace.Result
		err    error
	)
	if link {
		result, err = store.Link(r.Context(), actor, spaceID, body.Items)
	} else {
		result, err = store.Unlink(r.Context(), actor, spaceID, body.Items)
	}
	if err != nil {
		writeDataError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// ── Deletes ──────────────────────────────────────────────────────────────

func (b *Broker) handleDataDeletePreview(w http.ResponseWriter, r *http.Request, store dataspace.Store, actor dataspace.Actor, spaceID string, rest []string) {
	if len(rest) > 0 {
		writeDataNotFound(w)
		return
	}
	if r.Method != http.MethodPost {
		writeDataMethodNotAllowed(w)
		return
	}
	var body dataDeletePreviewRequest
	if !decodeDataBody(w, r, &body) {
		return
	}
	preview, err := store.PreviewDelete(r.Context(), actor, spaceID, body.Kind, body.IDs)
	if err != nil {
		writeDataError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, preview)
}

func (b *Broker) handleDataDelete(w http.ResponseWriter, r *http.Request, store dataspace.Store, actor dataspace.Actor, spaceID string, rest []string) {
	if len(rest) > 0 {
		writeDataNotFound(w)
		return
	}
	if r.Method != http.MethodPost {
		writeDataMethodNotAllowed(w)
		return
	}
	var body dataDeleteRequest
	if !decodeDataBody(w, r, &body) {
		return
	}
	impact, err := store.ExecuteDelete(r.Context(), actor, spaceID, body.Token)
	if err != nil {
		writeDataError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"impact": impact})
}

// ── App attachment ───────────────────────────────────────────────────────

// handleDataApps owns POST|DELETE .../apps/{appId}. The app id is validated
// with the same rule the /apps tree uses, so a malformed id never reaches the
// store.
func (b *Broker) handleDataApps(w http.ResponseWriter, r *http.Request, store dataspace.Store, actor dataspace.Actor, spaceID string, rest []string) {
	if len(rest) != 1 {
		writeDataNotFound(w)
		return
	}
	appID := rest[0]
	if err := validateCustomAppID(appID); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	var (
		space dataspace.Space
		err   error
	)
	switch r.Method {
	case http.MethodPost:
		space, err = store.AttachApp(r.Context(), actor, spaceID, appID)
	case http.MethodDelete:
		space, err = store.DetachApp(r.Context(), actor, spaceID, appID)
	default:
		writeDataMethodNotAllowed(w)
		return
	}
	if err != nil {
		writeDataError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"space": space})
}
