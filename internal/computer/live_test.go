package computer

import (
	"context"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"
)

// TestLiveContainerLifecycle drives a real runtime end to end: create a
// desktop for a throwaway bot, wait until Cua Driver answers, take a
// screenshot, put it to sleep, wake it, verify it is ready again, and remove
// it. It needs the managed image already prepared and is opt-in:
//
//	WUPHF_COMPUTER_LIVE=1 go test ./internal/computer -run TestLiveContainerLifecycle -v
func TestLiveContainerLifecycle(t *testing.T) {
	if os.Getenv("WUPHF_COMPUTER_LIVE") != "1" {
		t.Skip("set WUPHF_COMPUTER_LIVE=1 to run against a real container runtime")
	}
	ctx := context.Background()
	rt := DetectRuntime(ctx, ExecRunner, runtime.GOOS)
	if !rt.DaemonUp {
		t.Skipf("no running container runtime: %s", rt.Problem)
	}
	target := TargetFor("live-test-"+time.Now().Format("150405"), t.TempDir())
	in := &Inspector{Run: ExecRunner, Platform: runtime.GOOS}
	m := &Manager{Run: ExecRunner, Inspector: in, Platform: runtime.GOOS}
	t.Cleanup(func() {
		_, _ = m.Apply(ctx, rt, ActionRemove, target)
	})

	before := in.Inspect(ctx, rt, target)
	if !before.Image {
		t.Skipf("managed image not prepared: %s", before.Problem)
	}
	if _, err := m.Apply(ctx, rt, ActionRun, target); err != nil {
		t.Fatalf("run: %v", err)
	}
	waitReady := func(stage string) Status {
		deadline := time.Now().Add(120 * time.Second)
		var last Status
		for time.Now().Before(deadline) {
			in.Forget(target)
			last = in.Inspect(ctx, rt, target)
			if last.Ready {
				return last
			}
			if last.Container != ContainerRunning || last.Managed == false || last.Security == "unsafe" {
				t.Fatalf("%s: container failed verification: %+v", stage, last)
			}
			time.Sleep(3 * time.Second)
		}
		t.Fatalf("%s: desktop never became ready: %+v", stage, last)
		return last
	}
	s := waitReady("first boot")
	if s.ViewerPort == 0 || s.ViewerPassword == "" {
		t.Fatalf("viewer port/password missing: %+v", s)
	}
	frame, err := Screenshot(ctx, ExecRunner, rt.Runtime, target)
	if err != nil {
		t.Fatalf("screenshot: %v", err)
	}
	if !strings.HasPrefix(frame.DataURL, "data:image/jpeg;base64,") || len(frame.DataURL) < 2000 {
		t.Fatalf("unexpected frame %d bytes", len(frame.DataURL))
	}
	res, err := ExecShell(ctx, ExecRunner, rt.Runtime, target, "echo hello > "+WorkspaceGuest+"/marker.txt && cat "+WorkspaceGuest+"/marker.txt && id -un")
	if err != nil || res.ExitCode != 0 || !strings.Contains(res.Stdout, "hello") || !strings.Contains(res.Stdout, "cua") {
		t.Fatalf("exec: %v %+v", err, res)
	}
	if _, err := os.Stat(target.WorkspaceDir + "/marker.txt"); err != nil {
		t.Fatalf("workspace file must appear on the host: %v", err)
	}
	if _, err := m.Apply(ctx, rt, ActionStop, target); err != nil {
		t.Fatalf("stop: %v", err)
	}
	in.Forget(target)
	if st := in.Inspect(ctx, rt, target); st.Container != ContainerStopped || st.Ready {
		t.Fatalf("expected asleep, got %+v", st)
	}
	if _, err := m.Apply(ctx, rt, ActionStart, target); err != nil {
		t.Fatalf("start: %v", err)
	}
	waitReady("after wake")
	if _, err := m.Apply(ctx, rt, ActionRemove, target); err != nil {
		t.Fatalf("remove: %v", err)
	}
	in.Forget(target)
	if st := in.Inspect(ctx, rt, target); st.Container != ContainerMissing {
		t.Fatalf("expected missing after remove, got %+v", st)
	}
	if _, err := os.Stat(target.WorkspaceDir + "/marker.txt"); err != nil {
		t.Fatalf("workspace must survive removal: %v", err)
	}
}
