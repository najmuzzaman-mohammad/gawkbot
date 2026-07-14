package team

import (
	"bytes"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDecodeCustomAppValidateRequestIsStrictAndUTF8Safe(t *testing.T) {
	for _, body := range [][]byte{
		[]byte(`{"openui":"root = App(\"x\", [])","openui":"root = App(\"y\", [])"}`),
		[]byte(`{"openui":"root = App(\"x\", [])","unknown":true}`),
		[]byte(`{"openui":"root = App(\"x\", [])"} {}`),
		append([]byte(`{"openui":"`), 0xff, '"', '}'),
	} {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest("POST", "/apps/validate", bytes.NewReader(body))
		var dst struct {
			OpenUI string `json:"openui"`
		}
		if status, err := decodeCustomAppJSONBody(recorder, request, &dst, customAppMaxOpenUIBytes+1024); err == nil || status == 0 {
			t.Fatalf("strict validate decode accepted %q: status=%d dst=%+v", body, status, dst)
		}
	}
}

func TestCustomAppOpenUILifecycle(t *testing.T) {
	store := newCustomAppStore(t.TempDir())
	id := "app_0123456789abcdef"
	created, err := store.Scaffold(id, "Task desk", "", appBuilderSlug, time.Unix(1, 0))
	if err != nil {
		t.Fatal(err)
	}
	if got := customAppRepresentation(created); got != customAppRepresentationOpenUI {
		t.Fatalf("scaffold representation = %q", got)
	}
	if created.Entry != customAppOpenUIEntry || created.Version != 0 {
		t.Fatalf("unexpected scaffold: %#v", created)
	}
	if _, err := os.Stat(filepath.Join(store.appDir(id), customAppSourceDir)); !os.IsNotExist(err) {
		t.Fatalf("OpenUI scaffold unexpectedly created a Vite source tree: %v", err)
	}

	v0 := 0
	v1Body := `root = App("Task desk", [Text("Ready")])`
	v1, err := store.Save(CustomAppWriteRequest{
		ID: id, Name: "Task desk", OpenUI: v1Body, Actor: appBuilderSlug,
		ExpectedVersion: &v0,
	}, time.Unix(2, 0))
	if err != nil {
		t.Fatal(err)
	}
	if v1.Version != 1 || v1.ContentHash != customAppContentHash(v1Body) {
		t.Fatalf("unexpected v1: %#v", v1)
	}
	got, body, err := store.Get(id)
	if err != nil || body != v1Body || got.OpenUILibraryHash != customAppOpenUILibraryHash {
		t.Fatalf("get OpenUI = %#v %q %v", got, body, err)
	}

	stale := 0
	if _, err := store.Save(CustomAppWriteRequest{ID: id, Name: "Task desk", OpenUI: v1Body, ExpectedVersion: &stale}, time.Unix(3, 0)); !isCustomAppConflictError(err) {
		t.Fatalf("stale publish error = %v", err)
	}

	v1Expected := 1
	v2Body := `root = App("Task desk", [Text("Updated")])`
	if _, err := store.Save(CustomAppWriteRequest{ID: id, Name: "Task desk", OpenUI: v2Body, ExpectedVersion: &v1Expected}, time.Unix(4, 0)); err != nil {
		t.Fatal(err)
	}
	ver, historical, err := store.GetVersion(id, 1)
	if err != nil || ver.Representation != customAppRepresentationOpenUI || ver.Entry != customAppOpenUIEntry || historical != v1Body {
		t.Fatalf("historical OpenUI = %#v %q %v", ver, historical, err)
	}
	restored, err := store.Rollback(id, 1, "human", time.Unix(5, 0))
	if err != nil || restored.Version != 3 || customAppRepresentation(restored) != customAppRepresentationOpenUI {
		t.Fatalf("rollback = %#v %v", restored, err)
	}
	_, restoredBody, err := store.Get(id)
	if err != nil || restoredBody != v1Body {
		t.Fatalf("restored body = %q %v", restoredBody, err)
	}
}

func TestValidateCustomAppOpenUIPolicy(t *testing.T) {
	valid := `root = App("Tasks", [Button("Create", @Run(create), "info")])
tasks = Query("wuphf_list_tasks", {}, [])
create = Mutation("wuphf_create_task", {"title":"Follow up"})`
	if err := validateCustomAppOpenUI(valid); err != nil {
		t.Fatalf("valid document rejected: %v", err)
	}
	invalid := []string{
		`root = App(`,
		`root = App("Bad", []]`,
		`root = App("Bad", [Text("x")})`,
		`root = App("Bad, [])`,
		"root = App(\"Bad\\",
		"```openui\nroot = App(\"Bad\", [])\n```",
		"root = App(\"One\", [])\nroot = App(\"Two\", [])",
		"root = App(\"Bad\", [])\njunk",
		`root = App("Bad", [])
data = Query(toolName, {}, [])`,
		`root = App("Bad", [])
data = Query("read_local_files", {}, [])`,
		`root = App("Bad", [])
clear = Mutation("wuphf_app_db_clear", {"table":"items"})`,
		`root = App("Bad", [])
data = Query("wuphf_list_tasks", {}, [], 1)`,
		`root = App("Bad", [Button("Go", @OpenUrl("https://example.com"))])`,
		`<html><body>legacy</body></html>`,
	}
	for _, source := range invalid {
		if err := validateCustomAppOpenUI(source); err == nil {
			t.Fatalf("invalid document accepted: %s", source)
		}
	}
	validMultiline := `root = App("Tasks", [
  Text("Delimiters inside strings: [ ] { } ( )"),
  Card("Nested", [Text("Ready")]) // renderer content
])
# a whole-line comment
tasks = Query("wuphf_list_tasks", {}, [])`
	if err := validateCustomAppOpenUI(validMultiline); err != nil {
		t.Fatalf("valid multiline document rejected: %v", err)
	}
}

func TestCustomAppSaveRejectsIncompleteOpenUIBeforeWriting(t *testing.T) {
	root := t.TempDir()
	store := newCustomAppStore(root)
	if _, err := store.Save(CustomAppWriteRequest{
		Name: "Broken", OpenUI: `root = App(`,
	}, time.Unix(1, 0)); !isCustomAppCallerError(err) {
		t.Fatalf("incomplete OpenUI error = %v", err)
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("incomplete OpenUI wrote store entries: %v", entries)
	}
}

func TestCustomAppRollbackRejectsCorruptSnapshot(t *testing.T) {
	store := newCustomAppStore(t.TempDir())
	v1, err := store.Save(CustomAppWriteRequest{
		Name: "Task desk", OpenUI: `root = App("Tasks", [])`,
	}, time.Unix(1, 0))
	if err != nil {
		t.Fatal(err)
	}
	expected := v1.Version
	if _, err := store.Save(CustomAppWriteRequest{
		ID: v1.ID, Name: "Task desk", OpenUI: `root = App("Tasks v2", [])`, ExpectedVersion: &expected,
	}, time.Unix(2, 0)); err != nil {
		t.Fatal(err)
	}
	v1Path := filepath.Join(store.appDir(v1.ID), customAppVersionsDir, "v1", customAppOpenUIEntry)
	if err := os.WriteFile(v1Path, []byte(`root = App("tampered", [])`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Rollback(v1.ID, 1, "human", time.Unix(3, 0)); err == nil || !strings.Contains(err.Error(), "content hash") {
		t.Fatalf("corrupt rollback error = %v", err)
	}
	current, _, err := store.Get(v1.ID)
	if err != nil || current.Version != 2 {
		t.Fatalf("corrupt rollback changed current app: %+v %v", current, err)
	}
}
