package team

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

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
}
