package teammcp

// data_tools_handlers.go — the handlers behind the data-space tools.
//
// Each handler maps 1:1 onto one broker route: gate on the data-modeling system
// skill, validate what can be validated without a round trip, then hand the
// broker the documented body and pass its JSON straight back. The broker
// resolves WHICH bot is calling from the X-WUPHF-Agent header the MCP client
// already sends (server_broker_client.go authHeaders), so no tool takes an
// actor argument a model could forge.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func handleDataListSpaces(ctx context.Context, _ *mcp.CallToolRequest, _ DataListSpacesArgs) (*mcp.CallToolResult, any, error) {
	if err := dataSkillGate(ctx); err != nil {
		return toolError(err), nil, nil
	}
	var raw json.RawMessage
	if err := brokerGetJSON(ctx, "/data/spaces", &raw); err != nil {
		return toolError(readableDataError(err)), nil, nil
	}
	return dataResult(raw), nil, nil
}

func handleDataCreateSpace(ctx context.Context, _ *mcp.CallToolRequest, args DataCreateSpaceArgs) (*mcp.CallToolResult, any, error) {
	if err := dataSkillGate(ctx); err != nil {
		return toolError(err), nil, nil
	}
	name := strings.TrimSpace(args.Name)
	if name == "" {
		return toolError(errDataMissing("name", "name the use case this space is for, e.g. 'Seed raise'")), nil, nil
	}
	access, err := dataAccessBody(args.Access, args.Grants)
	if err != nil {
		return toolError(err), nil, nil
	}
	var raw json.RawMessage
	if err := brokerPostJSON(ctx, "/data/spaces", map[string]any{
		"name":        name,
		"description": strings.TrimSpace(args.Description),
		"access":      access,
	}, &raw); err != nil {
		return toolError(readableDataError(err)), nil, nil
	}
	return dataResult(raw), nil, nil
}

func handleDataGetSchema(ctx context.Context, _ *mcp.CallToolRequest, args DataGetSchemaArgs) (*mcp.CallToolResult, any, error) {
	if err := dataSkillGate(ctx); err != nil {
		return toolError(err), nil, nil
	}
	path, err := dataSpacePath(args.Space, "")
	if err != nil {
		return toolError(err), nil, nil
	}
	var raw json.RawMessage
	if err := brokerGetJSON(ctx, path, &raw); err != nil {
		return toolError(readableDataError(err)), nil, nil
	}
	return dataResult(raw), nil, nil
}

func handleDataCreateObjectTypes(ctx context.Context, _ *mcp.CallToolRequest, args DataCreateObjectTypesArgs) (*mcp.CallToolResult, any, error) {
	if err := dataSkillGate(ctx); err != nil {
		return toolError(err), nil, nil
	}
	path, err := dataSpacePath(args.Space, "/object-types")
	if err != nil {
		return toolError(err), nil, nil
	}
	if len(args.Items) == 0 {
		return toolError(errDataMissing("items", "pass the object types to create; call data_get_schema first so you extend an existing type instead of duplicating it")), nil, nil
	}
	var raw json.RawMessage
	if err := brokerPostJSON(ctx, path, map[string]any{"items": args.Items}, &raw); err != nil {
		return toolError(readableDataError(err)), nil, nil
	}
	return dataResult(raw), nil, nil
}

func handleDataAddAttributes(ctx context.Context, _ *mcp.CallToolRequest, args DataAddAttributesArgs) (*mcp.CallToolResult, any, error) {
	if err := dataSkillGate(ctx); err != nil {
		return toolError(err), nil, nil
	}
	typeRef, err := dataRef(args.ObjectType, "object_type", "pass the id or slug of the existing type from data_get_schema")
	if err != nil {
		return toolError(err), nil, nil
	}
	path, err := dataSpacePath(args.Space, "/object-types/"+typeRef+"/attributes")
	if err != nil {
		return toolError(err), nil, nil
	}
	if len(args.Items) == 0 {
		return toolError(errDataMissing("items", "pass the attributes to add")), nil, nil
	}
	var raw json.RawMessage
	if err := brokerPostJSON(ctx, path, map[string]any{"items": args.Items}, &raw); err != nil {
		return toolError(readableDataError(err)), nil, nil
	}
	return dataResult(raw), nil, nil
}

func handleDataUpdateAttribute(ctx context.Context, _ *mcp.CallToolRequest, args DataUpdateAttributeArgs) (*mcp.CallToolResult, any, error) {
	if err := dataSkillGate(ctx); err != nil {
		return toolError(err), nil, nil
	}
	typeRef, err := dataRef(args.ObjectType, "object_type", "pass the id or slug of the type the attribute belongs to")
	if err != nil {
		return toolError(err), nil, nil
	}
	attrRef, err := dataRef(args.Attribute, "attribute", "pass the id or slug of the attribute from data_get_schema")
	if err != nil {
		return toolError(err), nil, nil
	}
	path, err := dataSpacePath(args.Space, "/object-types/"+typeRef+"/attributes/"+attrRef)
	if err != nil {
		return toolError(err), nil, nil
	}
	patch := args.Patch
	if patch.Name == nil && patch.Description == nil && patch.IsRequired == nil &&
		len(patch.AddOptions) == 0 && patch.RenameOption == nil {
		return toolError(errDataMissing("patch", "say what to change: name, description, is_required, add_options or rename_option. Type, is_unique and is_multivalue cannot be changed after creation")), nil, nil
	}
	var raw json.RawMessage
	if err := dataBrokerPatchJSON(ctx, path, patch, &raw); err != nil {
		return toolError(readableDataError(err)), nil, nil
	}
	return dataResult(raw), nil, nil
}

func handleDataQueryRecords(ctx context.Context, _ *mcp.CallToolRequest, args DataQueryRecordsArgs) (*mcp.CallToolResult, any, error) {
	if err := dataSkillGate(ctx); err != nil {
		return toolError(err), nil, nil
	}
	path, err := dataSpacePath(args.Space, "/records/query")
	if err != nil {
		return toolError(err), nil, nil
	}
	if strings.TrimSpace(args.ObjectType) == "" {
		return toolError(errDataMissing("object_type", "pass the id or slug of the type to read, from data_get_schema")), nil, nil
	}
	body := map[string]any{"object_type": strings.TrimSpace(args.ObjectType)}
	if len(args.Filters) > 0 {
		body["filters"] = args.Filters
	}
	if args.Sort != nil {
		body["sort"] = args.Sort
	}
	if search := strings.TrimSpace(args.Query); search != "" {
		body["query"] = search
	}
	if args.Limit > 0 {
		body["limit"] = args.Limit
	}
	if args.Offset > 0 {
		body["offset"] = args.Offset
	}
	var raw json.RawMessage
	if err := brokerPostJSON(ctx, path, body, &raw); err != nil {
		return toolError(readableDataError(err)), nil, nil
	}
	return dataResult(raw), nil, nil
}

func handleDataCreateRecords(ctx context.Context, _ *mcp.CallToolRequest, args DataCreateRecordsArgs) (*mcp.CallToolResult, any, error) {
	if err := dataSkillGate(ctx); err != nil {
		return toolError(err), nil, nil
	}
	path, err := dataSpacePath(args.Space, "/records")
	if err != nil {
		return toolError(err), nil, nil
	}
	if strings.TrimSpace(args.ObjectType) == "" {
		return toolError(errDataMissing("object_type", "pass the id or slug of the type to create records of")), nil, nil
	}
	if len(args.Items) == 0 {
		return toolError(errDataMissing("items", "pass the records to create")), nil, nil
	}
	var raw json.RawMessage
	if err := brokerPostJSON(ctx, path, map[string]any{
		"object_type": strings.TrimSpace(args.ObjectType),
		"items":       args.Items,
	}, &raw); err != nil {
		return toolError(readableDataError(err)), nil, nil
	}
	return dataResult(raw), nil, nil
}

func handleDataUpsertRecords(ctx context.Context, _ *mcp.CallToolRequest, args DataUpsertRecordsArgs) (*mcp.CallToolResult, any, error) {
	if err := dataSkillGate(ctx); err != nil {
		return toolError(err), nil, nil
	}
	path, err := dataSpacePath(args.Space, "/records")
	if err != nil {
		return toolError(err), nil, nil
	}
	if strings.TrimSpace(args.ObjectType) == "" {
		return toolError(errDataMissing("object_type", "pass the id or slug of the type to write")), nil, nil
	}
	match := strings.TrimSpace(args.MatchingAttribute)
	if match == "" {
		return toolError(errDataMissing("matching_attribute", "name the UNIQUE attribute to match on (email, domain, external id) so a second run updates instead of duplicating")), nil, nil
	}
	if len(args.Items) == 0 {
		return toolError(errDataMissing("items", "pass the records to create or update")), nil, nil
	}
	var raw json.RawMessage
	if err := brokerPutJSON(ctx, path, map[string]any{
		"object_type":        strings.TrimSpace(args.ObjectType),
		"matching_attribute": match,
		"items":              args.Items,
	}, &raw); err != nil {
		return toolError(readableDataError(err)), nil, nil
	}
	return dataResult(raw), nil, nil
}

func handleDataUpdateRecord(ctx context.Context, _ *mcp.CallToolRequest, args DataUpdateRecordArgs) (*mcp.CallToolResult, any, error) {
	if err := dataSkillGate(ctx); err != nil {
		return toolError(err), nil, nil
	}
	recordRef, err := dataRef(args.Record, "record", "pass the record id exactly as data_query_records returned it")
	if err != nil {
		return toolError(err), nil, nil
	}
	path, err := dataSpacePath(args.Space, "/records/"+recordRef)
	if err != nil {
		return toolError(err), nil, nil
	}
	if len(args.Values) == 0 {
		return toolError(errDataMissing("values", "pass the attribute slugs to change; pass null as a value to clear one")), nil, nil
	}
	var raw json.RawMessage
	if err := dataBrokerPatchJSON(ctx, path, map[string]any{"values": args.Values}, &raw); err != nil {
		return toolError(readableDataError(err)), nil, nil
	}
	return dataResult(raw), nil, nil
}

func handleDataLinkRecords(ctx context.Context, _ *mcp.CallToolRequest, args DataLinkRecordsArgs) (*mcp.CallToolResult, any, error) {
	return dataLinkCall(ctx, args.Space, "/links", args.Items)
}

func handleDataUnlinkRecords(ctx context.Context, _ *mcp.CallToolRequest, args DataUnlinkRecordsArgs) (*mcp.CallToolResult, any, error) {
	return dataLinkCall(ctx, args.Space, "/unlinks", args.Items)
}

// dataLinkCall is the shared body of link and unlink: identical item shape,
// identical validation, different route.
func dataLinkCall(ctx context.Context, space, suffix string, items []DataLinkInput) (*mcp.CallToolResult, any, error) {
	if err := dataSkillGate(ctx); err != nil {
		return toolError(err), nil, nil
	}
	path, err := dataSpacePath(space, suffix)
	if err != nil {
		return toolError(err), nil, nil
	}
	if len(items) == 0 {
		return toolError(errDataMissing("items", "pass {record, attribute, target} for each pair")), nil, nil
	}
	for _, item := range items {
		if strings.TrimSpace(item.Record) == "" || strings.TrimSpace(item.Target) == "" {
			return toolError(errDataMissing("items", "every item needs record and target as record ids, exactly as they were returned")), nil, nil
		}
		if strings.TrimSpace(item.Attribute) == "" {
			return toolError(errDataMissing("items", "every item needs attribute: the relationship attribute's slug on the record's own object type")), nil, nil
		}
	}
	var raw json.RawMessage
	if err := brokerPostJSON(ctx, path, map[string]any{"items": items}, &raw); err != nil {
		return toolError(readableDataError(err)), nil, nil
	}
	return dataResult(raw), nil, nil
}

func handleDataShareSpace(ctx context.Context, _ *mcp.CallToolRequest, args DataShareSpaceArgs) (*mcp.CallToolResult, any, error) {
	if err := dataSkillGate(ctx); err != nil {
		return toolError(err), nil, nil
	}
	path, err := dataSpacePath(args.Space, "")
	if err != nil {
		return toolError(err), nil, nil
	}
	if strings.TrimSpace(args.Access) == "" {
		return toolError(errDataMissing("access", "pass private, shared or global")), nil, nil
	}
	access, err := dataAccessBody(args.Access, args.Grants)
	if err != nil {
		return toolError(err), nil, nil
	}
	var raw json.RawMessage
	if err := dataBrokerPatchJSON(ctx, path, map[string]any{"access": access}, &raw); err != nil {
		return toolError(readableDataError(err)), nil, nil
	}
	return dataResult(raw), nil, nil
}

func handleDataDeletePreview(ctx context.Context, _ *mcp.CallToolRequest, args DataDeletePreviewArgs) (*mcp.CallToolResult, any, error) {
	if err := dataSkillGate(ctx); err != nil {
		return toolError(err), nil, nil
	}
	path, err := dataSpacePath(args.Space, "/delete-preview")
	if err != nil {
		return toolError(err), nil, nil
	}
	kind := strings.ToLower(strings.TrimSpace(args.Kind))
	if !dataDeleteKinds[kind] {
		return toolError(errDataInvalid("kind", args.Kind, "use object_type, attribute, records, records_of_type or space")), nil, nil
	}
	ids := make([]string, 0, len(args.IDs))
	for _, id := range args.IDs {
		if trimmed := strings.TrimSpace(id); trimmed != "" {
			ids = append(ids, trimmed)
		}
	}
	if kind != "space" && len(ids) == 0 {
		return toolError(errDataMissing("ids", "name what to remove; only kind=space takes no ids")), nil, nil
	}
	var raw json.RawMessage
	if err := brokerPostJSON(ctx, path, map[string]any{"kind": kind, "ids": ids}, &raw); err != nil {
		return toolError(readableDataError(err)), nil, nil
	}
	return dataResult(raw), nil, nil
}

func handleDataDelete(ctx context.Context, _ *mcp.CallToolRequest, args DataDeleteArgs) (*mcp.CallToolResult, any, error) {
	if err := dataSkillGate(ctx); err != nil {
		return toolError(err), nil, nil
	}
	path, err := dataSpacePath(args.Space, "/delete")
	if err != nil {
		return toolError(err), nil, nil
	}
	token := strings.TrimSpace(args.Token)
	if token == "" {
		return toolError(errDataMissing("token", "call data_delete_preview first and show the operator the counts it returns")), nil, nil
	}
	var raw json.RawMessage
	if err := brokerPostJSON(ctx, path, map[string]any{"token": token}, &raw); err != nil {
		return toolError(readableDataError(err)), nil, nil
	}
	return dataResult(raw), nil, nil
}

// dataBrokerPatchJSON is brokerPostJSON with the PATCH verb, which three /data
// routes use (space sharing, attribute patch, record patch) and which no other
// teammcp caller needs. It lives with the data tools so the shared broker
// client stays exactly as the other tool surfaces left it.
func dataBrokerPatchJSON(ctx context.Context, path string, body any, out any) error {
	data, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPatch, brokerBaseURL()+path, strings.NewReader(string(data)))
	if err != nil {
		return err
	}
	req.Header = authHeaders()
	req.Header.Set("Content-Type", "application/json")
	res, err := brokerHTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		respBody, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		return fmt.Errorf("broker PATCH %s failed: %s %s", path, res.Status, strings.TrimSpace(string(respBody)))
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(res.Body).Decode(out)
}

// errDataMissing and errDataInvalid keep the argument-validation messages in
// one voice: what is wrong, then what to do about it.
func errDataMissing(field, remedy string) error {
	return fmt.Errorf("%s is required: %s", field, remedy)
}

func errDataInvalid(field, value, remedy string) error {
	return fmt.Errorf("%s %q is not valid: %s", field, value, remedy)
}
