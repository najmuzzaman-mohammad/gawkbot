package teammcp

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"slices"
	"sort"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/nex-crm/wuphf/internal/company"
	"github.com/nex-crm/wuphf/internal/dataspace"
)

// dataToolNames is the full surface, one tool per broker route.
var dataToolNames = []string{
	"data_list_spaces",
	"data_create_space",
	"data_get_schema",
	"data_create_object_types",
	"data_add_attributes",
	"data_update_attribute",
	"data_query_records",
	"data_create_records",
	"data_upsert_records",
	"data_update_record",
	"data_link_records",
	"data_unlink_records",
	"data_share_space",
	"data_delete_preview",
	"data_delete",
}

// anonymousBot clears the launcher-set identity so dataSkillGate cannot
// resolve a slug and therefore skips its /skills round trip. Handler tests
// that are not about the gate use it, so their stub broker only ever sees the
// /data call under test.
func anonymousBot(t *testing.T) {
	t.Helper()
	t.Setenv("WUPHF_AGENT_SLUG", "")
	t.Setenv("NEX_AGENT_SLUG", "")
}

// listRegisteredToolsFull is listRegisteredToolsWithSlug with the annotations
// kept, so a test can assert that the delete pair is marked destructive.
func listRegisteredToolsFull(t *testing.T, slug, channel string, oneOnOne bool) map[string]*mcp.Tool {
	t.Helper()
	ctx := context.Background()
	clientTransport, serverTransport := mcp.NewInMemoryTransports()

	server := mcp.NewServer(&mcp.Implementation{Name: "wuphf-team-test", Version: "0.1.0"}, nil)
	configureServerTools(server, slug, channel, oneOnOne)

	serverSession, err := server.Connect(ctx, serverTransport, nil)
	if err != nil {
		t.Fatalf("server connect: %v", err)
	}
	defer serverSession.Wait()

	client := mcp.NewClient(&mcp.Implementation{Name: "client", Version: "0.1.0"}, nil)
	clientSession, err := client.Connect(ctx, clientTransport, nil)
	if err != nil {
		t.Fatalf("client connect: %v", err)
	}
	defer func() { _ = clientSession.Close() }()

	tools, err := clientSession.ListTools(ctx, nil)
	if err != nil {
		t.Fatalf("list tools: %v", err)
	}
	byName := make(map[string]*mcp.Tool, len(tools.Tools))
	for _, tool := range tools.Tools {
		byName[tool.Name] = tool
	}
	return byName
}

// TestDataToolsRegisteredInBothModes pins the registration wiring: the office
// branch and the lean app-builder branch both call registerDataTools, because
// the builder models the data its app reads.
func TestDataToolsRegisteredInBothModes(t *testing.T) {
	for _, mode := range []struct {
		name    string
		slug    string
		channel string
	}{
		{name: "office", slug: "ops", channel: "general"},
		{name: "app builder", slug: company.AppBuilderSlug, channel: "app-build"},
	} {
		t.Run(mode.name, func(t *testing.T) {
			names := listRegisteredToolsWithSlug(t, mode.slug, mode.channel, false)
			for _, want := range dataToolNames {
				if !slices.Contains(names, want) {
					t.Errorf("%s mode is missing %s", mode.name, want)
				}
			}
		})
	}
}

// TestDataDeletePairIsDestructive: both halves of the delete carry the
// destructive annotation, so a host that asks before destructive calls asks
// before either one.
func TestDataDeletePairIsDestructive(t *testing.T) {
	tools := listRegisteredToolsFull(t, "ops", "general", false)
	for _, name := range []string{"data_delete_preview", "data_delete"} {
		tool, ok := tools[name]
		if !ok {
			t.Fatalf("%s is not registered", name)
		}
		if tool.Annotations == nil || tool.Annotations.DestructiveHint == nil || !*tool.Annotations.DestructiveHint {
			t.Errorf("%s must be registered with officeDestructiveTool", name)
		}
	}
	// The reads stay reads: a bot (and the host) should be able to tell them
	// apart from the writes.
	for _, name := range []string{"data_list_spaces", "data_get_schema", "data_query_records"} {
		tool, ok := tools[name]
		if !ok {
			t.Fatalf("%s is not registered", name)
		}
		if tool.Annotations == nil || !tool.Annotations.ReadOnlyHint {
			t.Errorf("%s must be registered with readOnlyTool", name)
		}
	}
}

// TestDataToolDescriptionsCarryTheRules is the guard on the thing that
// actually decides whether a bot can build a data model: the instructions. A
// description that loses one of these rules is a regression, not a wording
// change.
func TestDataToolDescriptionsCarryTheRules(t *testing.T) {
	tools := listRegisteredToolsFull(t, "ops", "general", false)
	rules := map[string][]string{
		"data_get_schema":          {"BEFORE", "data_add_attributes", "primary `name`", "Never invent"},
		"data_create_object_types": {"data_get_schema first", "relationship IS an attribute", "cardinality cannot be changed", "entries"},
		"data_add_attributes":      {"already exists", "fixed at creation", "entries"},
		"data_update_attribute":    {"near-duplicate", "251-500"},
		"data_create_records":      {"data_upsert_records", "never invent an option value", "entries"},
		"data_upsert_records":      {"unique", "entries"},
		"data_update_record":       {"exactly as it was returned"},
		"data_link_records":        {"replace=true", "no-op"},
		"data_delete_preview":      {"token", "operator"},
		"data_delete":              {"cannot be undone"},
		"data_share_space":         {"private", "global"},
	}
	for name, needles := range rules {
		tool, ok := tools[name]
		if !ok {
			t.Fatalf("%s is not registered", name)
		}
		for _, needle := range needles {
			if !strings.Contains(tool.Description, needle) {
				t.Errorf("%s description lost the rule mentioning %q", name, needle)
			}
		}
	}
}

// TestDataToolInputsMirrorDataspace fails when the store's JSON shape and the
// tool arguments drift apart. The tool types are hand-written mirrors (they
// carry the jsonschema instructions), so this is the only thing keeping them
// honest.
func TestDataToolInputsMirrorDataspace(t *testing.T) {
	jsonFields := func(v any) []string {
		rt := reflect.TypeOf(v)
		names := make([]string, 0, rt.NumField())
		for i := 0; i < rt.NumField(); i++ {
			tag := rt.Field(i).Tag.Get("json")
			name, _, _ := strings.Cut(tag, ",")
			if name == "" || name == "-" {
				continue
			}
			names = append(names, name)
		}
		sort.Strings(names)
		return names
	}
	cases := []struct {
		name  string
		mine  any
		store any
	}{
		{"AttributeInput", DataAttributeInput{}, dataspace.AttributeInput{}},
		{"RelationshipInput", DataRelationshipInput{}, dataspace.RelationshipInput{}},
		{"ObjectTypeInput", DataObjectTypeInput{}, dataspace.ObjectTypeInput{}},
		{"AttributePatch", DataAttributePatch{}, dataspace.AttributePatch{}},
		{"RecordInput", DataRecordInput{}, dataspace.RecordInput{}},
		{"Filter", DataFilterInput{}, dataspace.Filter{}},
		{"Sort", DataSortInput{}, dataspace.Sort{}},
		{"LinkInput", DataLinkInput{}, dataspace.LinkInput{}},
		{"Grant", DataGrantInput{}, dataspace.Grant{}},
	}
	for _, tc := range cases {
		mine, store := jsonFields(tc.mine), jsonFields(tc.store)
		if !slices.Equal(mine, store) {
			t.Errorf("%s drifted: tools have %v, internal/dataspace has %v", tc.name, mine, store)
		}
	}

	// The query body is assembled by hand rather than mirrored by a struct, so
	// pin the store's field names directly.
	wantQuery := []string{"filters", "limit", "object_type", "offset", "query", "sort"}
	if got := jsonFields(dataspace.Query{}); !slices.Equal(got, wantQuery) {
		t.Errorf("dataspace.Query fields changed: got %v, want %v — update handleDataQueryRecords", got, wantQuery)
	}
}

// brokerCall is one recorded request against the stub broker.
type brokerCall struct {
	method string
	path   string
	body   map[string]any
}

// recordingBroker returns a stub that records every call and answers each with
// the supplied JSON body, so a test can assert the exact sequence a bot makes.
func recordingBroker(t *testing.T, reply string) (*[]brokerCall, func()) {
	t.Helper()
	calls := make([]brokerCall, 0, 8)
	var auth *testingAuth
	srv, auth := stubBroker(t, func(w http.ResponseWriter, r *http.Request) {
		call := brokerCall{method: r.Method, path: r.URL.Path}
		if body := strings.TrimSpace(auth.lastBody); body != "" {
			_ = json.Unmarshal([]byte(body), &call.body)
		}
		calls = append(calls, call)
		_, _ = w.Write([]byte(reply))
	})
	withBrokerURL(t, srv.URL)
	return &calls, srv.Close
}

// TestDataToolHandlersHitDocumentedRoutes walks every handler and pins the
// method, path and body it sends. These are the broker's documented /data
// routes; a handler that drifts from one sends a bot's write into a 404.
func TestDataToolHandlersHitDocumentedRoutes(t *testing.T) {
	anonymousBot(t)
	ctx := context.Background()
	name := "Stage"
	cases := []struct {
		tool       string
		invoke     func() (*mcp.CallToolResult, any, error)
		wantMethod string
		wantPath   string
		wantBody   map[string]any
	}{
		{
			tool:       "data_list_spaces",
			invoke:     func() (*mcp.CallToolResult, any, error) { return handleDataListSpaces(ctx, nil, DataListSpacesArgs{}) },
			wantMethod: http.MethodGet,
			wantPath:   "/data/spaces",
		},
		{
			tool: "data_create_space",
			invoke: func() (*mcp.CallToolResult, any, error) {
				return handleDataCreateSpace(ctx, nil, DataCreateSpaceArgs{Name: "Seed raise", Description: "Sam's raise"})
			},
			wantMethod: http.MethodPost,
			wantPath:   "/data/spaces",
			wantBody: map[string]any{
				"name":        "Seed raise",
				"description": "Sam's raise",
				"access":      map[string]any{"scope": "private"},
			},
		},
		{
			tool: "data_get_schema",
			invoke: func() (*mcp.CallToolResult, any, error) {
				return handleDataGetSchema(ctx, nil, DataGetSchemaArgs{Space: "spc_1"})
			},
			wantMethod: http.MethodGet,
			wantPath:   "/data/spaces/spc_1",
		},
		{
			tool: "data_create_object_types",
			invoke: func() (*mcp.CallToolResult, any, error) {
				return handleDataCreateObjectTypes(ctx, nil, DataCreateObjectTypesArgs{
					Space: "spc_1",
					Items: []DataObjectTypeInput{{
						Name: "Investor",
						Attributes: []DataAttributeInput{
							{Name: "Email", Type: "email", IsUnique: true},
							{Name: "Firm", Type: "relationship", Relationship: &DataRelationshipInput{
								Target: "Firm", Cardinality: "many_to_one", InverseName: "Investors",
							}},
						},
					}},
				})
			},
			wantMethod: http.MethodPost,
			wantPath:   "/data/spaces/spc_1/object-types",
		},
		{
			tool: "data_add_attributes",
			invoke: func() (*mcp.CallToolResult, any, error) {
				return handleDataAddAttributes(ctx, nil, DataAddAttributesArgs{
					Space: "spc_1", ObjectType: "deliverable",
					Items: []DataAttributeInput{{Name: "Priority", Type: "select", Options: []string{"low", "medium", "high"}}},
				})
			},
			wantMethod: http.MethodPost,
			wantPath:   "/data/spaces/spc_1/object-types/deliverable/attributes",
		},
		{
			tool: "data_update_attribute",
			invoke: func() (*mcp.CallToolResult, any, error) {
				return handleDataUpdateAttribute(ctx, nil, DataUpdateAttributeArgs{
					Space: "spc_1", ObjectType: "investor", Attribute: "stage",
					Patch: DataAttributePatch{Name: &name, AddOptions: []string{"Term sheet"}},
				})
			},
			wantMethod: http.MethodPatch,
			wantPath:   "/data/spaces/spc_1/object-types/investor/attributes/stage",
			wantBody:   map[string]any{"name": "Stage", "add_options": []any{"Term sheet"}},
		},
		{
			tool: "data_query_records",
			invoke: func() (*mcp.CallToolResult, any, error) {
				return handleDataQueryRecords(ctx, nil, DataQueryRecordsArgs{
					Space: "spc_1", ObjectType: "investor",
					Filters: []DataFilterInput{{Attribute: "stage", Operator: "equals", Value: "Pitched"}},
					Sort:    &DataSortInput{Attribute: "stage", Desc: true},
					Query:   "acme", Limit: 30, Offset: 30,
				})
			},
			wantMethod: http.MethodPost,
			wantPath:   "/data/spaces/spc_1/records/query",
			wantBody: map[string]any{
				"object_type": "investor",
				"filters":     []any{map[string]any{"attribute": "stage", "operator": "equals", "value": "Pitched"}},
				"sort":        map[string]any{"attribute": "stage", "desc": true},
				"query":       "acme",
				"limit":       float64(30),
				"offset":      float64(30),
			},
		},
		{
			tool: "data_create_records",
			invoke: func() (*mcp.CallToolResult, any, error) {
				return handleDataCreateRecords(ctx, nil, DataCreateRecordsArgs{
					Space: "spc_1", ObjectType: "investor",
					Items: []DataRecordInput{{Values: map[string]any{"name": "Ada"}}},
				})
			},
			wantMethod: http.MethodPost,
			wantPath:   "/data/spaces/spc_1/records",
			wantBody: map[string]any{
				"object_type": "investor",
				"items":       []any{map[string]any{"values": map[string]any{"name": "Ada"}}},
			},
		},
		{
			tool: "data_upsert_records",
			invoke: func() (*mcp.CallToolResult, any, error) {
				return handleDataUpsertRecords(ctx, nil, DataUpsertRecordsArgs{
					Space: "spc_1", ObjectType: "investor", MatchingAttribute: "email",
					Items: []DataRecordInput{{Values: map[string]any{"email": "ada@example.com"}}},
				})
			},
			wantMethod: http.MethodPut,
			wantPath:   "/data/spaces/spc_1/records",
			wantBody: map[string]any{
				"object_type":        "investor",
				"matching_attribute": "email",
				"items":              []any{map[string]any{"values": map[string]any{"email": "ada@example.com"}}},
			},
		},
		{
			tool: "data_update_record",
			invoke: func() (*mcp.CallToolResult, any, error) {
				return handleDataUpdateRecord(ctx, nil, DataUpdateRecordArgs{
					Space: "spc_1", Record: "rec_7", Values: map[string]any{"stage": "Committed"},
				})
			},
			wantMethod: http.MethodPatch,
			wantPath:   "/data/spaces/spc_1/records/rec_7",
			wantBody:   map[string]any{"values": map[string]any{"stage": "Committed"}},
		},
		{
			tool: "data_link_records",
			invoke: func() (*mcp.CallToolResult, any, error) {
				return handleDataLinkRecords(ctx, nil, DataLinkRecordsArgs{
					Space: "spc_1",
					Items: []DataLinkInput{{Record: "rec_7", Attribute: "firm", Target: "rec_9", Replace: true}},
				})
			},
			wantMethod: http.MethodPost,
			wantPath:   "/data/spaces/spc_1/links",
			wantBody: map[string]any{"items": []any{map[string]any{
				"record": "rec_7", "attribute": "firm", "target": "rec_9", "replace": true,
			}}},
		},
		{
			tool: "data_unlink_records",
			invoke: func() (*mcp.CallToolResult, any, error) {
				return handleDataUnlinkRecords(ctx, nil, DataUnlinkRecordsArgs{
					Space: "spc_1",
					Items: []DataLinkInput{{Record: "rec_7", Attribute: "firm", Target: "rec_9"}},
				})
			},
			wantMethod: http.MethodPost,
			wantPath:   "/data/spaces/spc_1/unlinks",
		},
		{
			tool: "data_share_space",
			invoke: func() (*mcp.CallToolResult, any, error) {
				return handleDataShareSpace(ctx, nil, DataShareSpaceArgs{
					Space: "spc_1", Access: "shared",
					Grants: []DataGrantInput{{Bot: "Ops", Level: "write"}},
				})
			},
			wantMethod: http.MethodPatch,
			wantPath:   "/data/spaces/spc_1",
			wantBody: map[string]any{"access": map[string]any{
				"scope":  "shared",
				"grants": []any{map[string]any{"bot": "ops", "level": "write"}},
			}},
		},
		{
			tool: "data_delete_preview",
			invoke: func() (*mcp.CallToolResult, any, error) {
				return handleDataDeletePreview(ctx, nil, DataDeletePreviewArgs{
					Space: "spc_1", Kind: "object_type", IDs: []string{"ot_3"},
				})
			},
			wantMethod: http.MethodPost,
			wantPath:   "/data/spaces/spc_1/delete-preview",
			wantBody:   map[string]any{"kind": "object_type", "ids": []any{"ot_3"}},
		},
		{
			tool: "data_delete",
			invoke: func() (*mcp.CallToolResult, any, error) {
				return handleDataDelete(ctx, nil, DataDeleteArgs{Space: "spc_1", Token: "tok_1"})
			},
			wantMethod: http.MethodPost,
			wantPath:   "/data/spaces/spc_1/delete",
			wantBody:   map[string]any{"token": "tok_1"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.tool, func(t *testing.T) {
			calls, closeBroker := recordingBroker(t, `{"succeeded":1,"failed":0,"summary":"ok","entries":[]}`)
			defer closeBroker()

			res, _, err := tc.invoke()
			if err != nil {
				t.Fatalf("handler returned a protocol error: %v", err)
			}
			if isToolError(res) {
				t.Fatalf("tool error: %s", toolErrorText(res))
			}
			if len(*calls) != 1 {
				t.Fatalf("want exactly one broker call, got %d: %+v", len(*calls), *calls)
			}
			call := (*calls)[0]
			if call.method != tc.wantMethod || call.path != tc.wantPath {
				t.Fatalf("sent %s %s, want %s %s", call.method, call.path, tc.wantMethod, tc.wantPath)
			}
			for key, want := range tc.wantBody {
				got, ok := call.body[key]
				if !ok {
					t.Errorf("body is missing %q: %+v", key, call.body)
					continue
				}
				if !reflect.DeepEqual(got, want) {
					t.Errorf("body[%q] = %#v, want %#v", key, got, want)
				}
			}
			if strings.TrimSpace(toolErrorText(res)) == "" {
				t.Error("handler returned an empty result; the broker's JSON should pass straight through")
			}
		})
	}
}

// TestDataToolArgsValidation covers the mistakes a bot makes before the
// broker ever sees them: no space, a made-up access level, a delete without a
// preview token.
func TestDataToolArgsValidation(t *testing.T) {
	anonymousBot(t)
	ctx := context.Background()
	srv, _ := stubBroker(t, func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("no broker call should be made for invalid args, got %s %s", r.Method, r.URL.Path)
		w.WriteHeader(http.StatusInternalServerError)
	})
	defer srv.Close()
	withBrokerURL(t, srv.URL)

	cases := []struct {
		name   string
		invoke func() (*mcp.CallToolResult, any, error)
		want   string
	}{
		{
			name:   "schema without a space",
			invoke: func() (*mcp.CallToolResult, any, error) { return handleDataGetSchema(ctx, nil, DataGetSchemaArgs{}) },
			want:   "space is required",
		},
		{
			name: "records without a space",
			invoke: func() (*mcp.CallToolResult, any, error) {
				return handleDataCreateRecords(ctx, nil, DataCreateRecordsArgs{ObjectType: "investor"})
			},
			want: "space is required",
		},
		{
			name: "made-up access level",
			invoke: func() (*mcp.CallToolResult, any, error) {
				return handleDataCreateSpace(ctx, nil, DataCreateSpaceArgs{Name: "Seed raise", Access: "public"})
			},
			want: "private, shared or global",
		},
		{
			name: "shared without grants",
			invoke: func() (*mcp.CallToolResult, any, error) {
				return handleDataShareSpace(ctx, nil, DataShareSpaceArgs{Space: "spc_1", Access: "shared"})
			},
			want: "needs grants",
		},
		{
			name: "grant with a made-up level",
			invoke: func() (*mcp.CallToolResult, any, error) {
				return handleDataShareSpace(ctx, nil, DataShareSpaceArgs{
					Space: "spc_1", Access: "shared", Grants: []DataGrantInput{{Bot: "ops", Level: "admin"}},
				})
			},
			want: "use read or write",
		},
		{
			name: "upsert without a matching attribute",
			invoke: func() (*mcp.CallToolResult, any, error) {
				return handleDataUpsertRecords(ctx, nil, DataUpsertRecordsArgs{
					Space: "spc_1", ObjectType: "investor",
					Items: []DataRecordInput{{Values: map[string]any{"name": "Ada"}}},
				})
			},
			want: "matching_attribute is required",
		},
		{
			name: "delete kind that does not exist",
			invoke: func() (*mcp.CallToolResult, any, error) {
				return handleDataDeletePreview(ctx, nil, DataDeletePreviewArgs{Space: "spc_1", Kind: "everything", IDs: []string{"ot_1"}})
			},
			want: "not valid",
		},
		{
			name: "delete without a token",
			invoke: func() (*mcp.CallToolResult, any, error) {
				return handleDataDelete(ctx, nil, DataDeleteArgs{Space: "spc_1"})
			},
			want: "data_delete_preview",
		},
		{
			name: "link without an attribute",
			invoke: func() (*mcp.CallToolResult, any, error) {
				return handleDataLinkRecords(ctx, nil, DataLinkRecordsArgs{
					Space: "spc_1", Items: []DataLinkInput{{Record: "rec_1", Target: "rec_2"}},
				})
			},
			want: "every item needs attribute",
		},
		{
			name: "attribute patch that changes nothing",
			invoke: func() (*mcp.CallToolResult, any, error) {
				return handleDataUpdateAttribute(ctx, nil, DataUpdateAttributeArgs{
					Space: "spc_1", ObjectType: "investor", Attribute: "stage",
				})
			},
			want: "cannot be changed after creation",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res, _, err := tc.invoke()
			if err != nil {
				t.Fatalf("handler returned a protocol error: %v", err)
			}
			if !isToolError(res) {
				t.Fatalf("expected a tool error, got %q", toolErrorText(res))
			}
			if !strings.Contains(toolErrorText(res), tc.want) {
				t.Fatalf("error %q does not mention %q", toolErrorText(res), tc.want)
			}
		})
	}
}

// TestDataToolBrokerValidationErrorIsReadable: the store answers an invalid
// select value with the valid options and the offending attribute. That is
// the self-correcting error the whole surface leans on, so it must reach the
// bot as a sentence, not buried in an HTTP status line.
func TestDataToolBrokerValidationErrorIsReadable(t *testing.T) {
	anonymousBot(t)
	srv, _ := stubBroker(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error":     `"urgent" is not a valid option. Valid options: low, medium, high.`,
			"attribute": "priority",
		})
	})
	defer srv.Close()
	withBrokerURL(t, srv.URL)

	res, _, err := handleDataCreateRecords(context.Background(), nil, DataCreateRecordsArgs{
		Space: "spc_1", ObjectType: "deliverable",
		Items: []DataRecordInput{{Values: map[string]any{"priority": "urgent"}}},
	})
	if err != nil {
		t.Fatalf("handler returned a protocol error: %v", err)
	}
	if !isToolError(res) {
		t.Fatal("a broker 400 must surface as a tool error")
	}
	text := toolErrorText(res)
	if !strings.HasPrefix(text, "priority: ") {
		t.Errorf("error should lead with the offending attribute, got %q", text)
	}
	for _, needle := range []string{"urgent", "low, medium, high"} {
		if !strings.Contains(text, needle) {
			t.Errorf("error %q lost %q — the bot cannot self-correct without it", text, needle)
		}
	}
	if strings.Contains(text, "400 Bad Request") {
		t.Errorf("error still wraps the HTTP status line: %q", text)
	}
}

// TestDataToolSystemSkillGate: an operator who switches data-modeling off for
// one bot gets a refusal that says so, and no /data call is made.
func TestDataToolSystemSkillGate(t *testing.T) {
	t.Setenv("WUPHF_AGENT_SLUG", "ops")
	var dataCalls int
	srv, _ := stubBroker(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/data") {
			dataCalls++
			t.Errorf("gated tool still called the broker: %s %s", r.Method, r.URL.Path)
		}
		if r.URL.Path != "/skills" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"skills": []map[string]any{{
			"name":            "data-modeling",
			"system":          true,
			"disabled_agents": []string{"ops"},
		}}})
	})
	defer srv.Close()
	withBrokerURL(t, srv.URL)

	ctx := context.Background()
	gated := []func() (*mcp.CallToolResult, any, error){
		func() (*mcp.CallToolResult, any, error) { return handleDataListSpaces(ctx, nil, DataListSpacesArgs{}) },
		func() (*mcp.CallToolResult, any, error) {
			return handleDataGetSchema(ctx, nil, DataGetSchemaArgs{Space: "spc_1"})
		},
		func() (*mcp.CallToolResult, any, error) {
			return handleDataCreateSpace(ctx, nil, DataCreateSpaceArgs{Name: "Seed raise"})
		},
		func() (*mcp.CallToolResult, any, error) {
			return handleDataCreateObjectTypes(ctx, nil, DataCreateObjectTypesArgs{
				Space: "spc_1", Items: []DataObjectTypeInput{{Name: "Investor"}},
			})
		},
		func() (*mcp.CallToolResult, any, error) {
			return handleDataDelete(ctx, nil, DataDeleteArgs{Space: "spc_1", Token: "tok_1"})
		},
	}
	for i, invoke := range gated {
		res, _, err := invoke()
		if err != nil {
			t.Fatalf("handler %d returned a protocol error: %v", i, err)
		}
		if !isToolError(res) {
			t.Fatalf("handler %d ran while data-modeling is disabled", i)
		}
		if !strings.Contains(toolErrorText(res), "data-modeling system skill is disabled for @ops") {
			t.Fatalf("handler %d refusal does not name the skill: %q", i, toolErrorText(res))
		}
	}
	if dataCalls != 0 {
		t.Fatalf("%d /data calls leaked past the gate", dataCalls)
	}
}

// TestICPExample1StepsOneToThree walks the spec's first acceptance example
// through the real handlers: Sam says "track my seed raise", and a
// well-behaved bot looks before it creates, creates the three types AND the
// relationships in ONE call, re-reads the schema because the store added the
// primary name attribute, then upserts on the unique email so a second run
// does not duplicate anyone.
func TestICPExample1StepsOneToThree(t *testing.T) {
	anonymousBot(t)
	ctx := context.Background()
	calls, closeBroker := recordingBroker(t, `{"succeeded":3,"failed":0,"summary":"3 created","entries":[]}`)
	defer closeBroker()

	step := func(res *mcp.CallToolResult, err error, label string) {
		t.Helper()
		if err != nil {
			t.Fatalf("%s: protocol error: %v", label, err)
		}
		if isToolError(res) {
			t.Fatalf("%s: tool error: %s", label, toolErrorText(res))
		}
	}

	// 1. Look before creating: which spaces exist, and what is already modeled.
	res, _, err := handleDataListSpaces(ctx, nil, DataListSpacesArgs{})
	step(res, err, "list spaces")
	res, _, err = handleDataCreateSpace(ctx, nil, DataCreateSpaceArgs{
		Name: "Seed raise", Description: "Investors, firms and meetings for the seed round",
	})
	step(res, err, "create space")
	res, _, err = handleDataGetSchema(ctx, nil, DataGetSchemaArgs{Space: "spc_seed"})
	step(res, err, "schema before creating")

	// 2. Three types and BOTH relationships in one call.
	res, _, err = handleDataCreateObjectTypes(ctx, nil, DataCreateObjectTypesArgs{
		Space: "spc_seed",
		Items: []DataObjectTypeInput{
			{Name: "Firm", Attributes: []DataAttributeInput{
				{Name: "Domain", Type: "text", IsUnique: true},
				{Name: "Tier", Type: "select", Options: []string{"Tier 1", "Tier 2", "Tier 3"}},
			}},
			{Name: "Investor", Attributes: []DataAttributeInput{
				{Name: "Email", Type: "email", IsUnique: true},
				{Name: "Stage", Type: "status", Options: []string{"Intro", "Pitched", "Diligence", "Committed", "Passed"}},
				{Name: "Check size", Type: "currency", CurrencyCode: "USD"},
				{Name: "Firm", Type: "relationship", Relationship: &DataRelationshipInput{
					Target: "Firm", Cardinality: "many_to_one", InverseName: "Investors",
				}},
			}},
			{Name: "Meeting", Attributes: []DataAttributeInput{
				{Name: "Date", Type: "date"},
				{Name: "Notes", Type: "text"},
				{Name: "Investor", Type: "relationship", Relationship: &DataRelationshipInput{
					Target: "Investor", Cardinality: "many_to_one", InverseName: "Meetings",
				}},
			}},
		},
	})
	step(res, err, "create object types")

	// 3. Re-read the schema (the store added the primary name attribute and
	// minted the option ids), then upsert on the unique email.
	res, _, err = handleDataGetSchema(ctx, nil, DataGetSchemaArgs{Space: "spc_seed"})
	step(res, err, "schema after creating")
	res, _, err = handleDataUpsertRecords(ctx, nil, DataUpsertRecordsArgs{
		Space: "spc_seed", ObjectType: "investor", MatchingAttribute: "email",
		Items: []DataRecordInput{
			{Values: map[string]any{"name": "Ada Byron", "email": "ada@example.com", "stage": "Pitched"}},
			{Values: map[string]any{"name": "Grace Hopper", "email": "grace@example.com", "stage": "Intro"}},
		},
	})
	step(res, err, "upsert investors")

	want := []brokerCall{
		{method: http.MethodGet, path: "/data/spaces"},
		{method: http.MethodPost, path: "/data/spaces"},
		{method: http.MethodGet, path: "/data/spaces/spc_seed"},
		{method: http.MethodPost, path: "/data/spaces/spc_seed/object-types"},
		{method: http.MethodGet, path: "/data/spaces/spc_seed"},
		{method: http.MethodPut, path: "/data/spaces/spc_seed/records"},
	}
	if len(*calls) != len(want) {
		t.Fatalf("want %d broker calls, got %d: %+v", len(want), len(*calls), *calls)
	}
	for i, wantCall := range want {
		got := (*calls)[i]
		if got.method != wantCall.method || got.path != wantCall.path {
			t.Fatalf("call %d was %s %s, want %s %s", i, got.method, got.path, wantCall.method, wantCall.path)
		}
	}

	// The one call that carries the whole model: three types, two
	// relationships, and nobody defining their own `name` attribute.
	items, ok := (*calls)[3].body["items"].([]any)
	if !ok || len(items) != 3 {
		t.Fatalf("object-type call should carry three types, got %+v", (*calls)[3].body)
	}
	relationships := 0
	for _, item := range items {
		typeBody, _ := item.(map[string]any)
		attrs, _ := typeBody["attributes"].([]any)
		for _, attr := range attrs {
			attrBody, _ := attr.(map[string]any)
			if slug, _ := attrBody["name"].(string); strings.EqualFold(slug, "name") {
				t.Errorf("a bot must not define its own `name` attribute: %+v", attrBody)
			}
			if _, has := attrBody["relationship"]; has {
				relationships++
				if attrBody["type"] != "relationship" {
					t.Errorf("a relationship attribute must be type=relationship: %+v", attrBody)
				}
			}
		}
	}
	if relationships != 2 {
		t.Fatalf("want both relationships created in the same call, got %d", relationships)
	}
	if match := (*calls)[5].body["matching_attribute"]; match != "email" {
		t.Fatalf("the re-import must match on the unique email, got %v", match)
	}
}
