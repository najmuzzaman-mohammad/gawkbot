package teammcp

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestAppBuilderRegisterSchemaIsOpenUIOnly(t *testing.T) {
	ctx := context.Background()
	clientTransport, serverTransport := mcp.NewInMemoryTransports()
	server := mcp.NewServer(&mcp.Implementation{Name: "wuphf-app-tools-test", Version: "0.1.0"}, nil)
	registerAppTools(server, appBuilderSlug)
	serverSession, err := server.Connect(ctx, serverTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer serverSession.Wait()
	client := mcp.NewClient(&mcp.Implementation{Name: "client", Version: "0.1.0"}, nil)
	clientSession, err := client.Connect(ctx, clientTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer clientSession.Close()
	listed, err := clientSession.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	var register *mcp.Tool
	names := map[string]bool{}
	for _, tool := range listed.Tools {
		names[tool.Name] = true
		if tool.Name == "register_app" {
			register = tool
		}
	}
	if !names["get_app"] || !names["validate_app"] || register == nil {
		t.Fatalf("App Builder tools = %v", names)
	}
	raw, err := json.Marshal(register.InputSchema)
	if err != nil {
		t.Fatal(err)
	}
	schema := string(raw)
	for _, required := range []string{"openui_lang", "expected_version", "app_id"} {
		if !strings.Contains(schema, `"`+required+`"`) {
			t.Errorf("register_app schema missing %q: %s", required, schema)
		}
	}
	for _, legacy := range []string{"html", "html_path", "source_path", "files"} {
		if strings.Contains(schema, `"`+legacy+`"`) {
			t.Errorf("register_app schema exposes legacy field %q: %s", legacy, schema)
		}
	}
}
