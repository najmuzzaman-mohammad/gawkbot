package computer

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// scriptedRunner answers runtime commands from a table keyed by the joined
// argv prefix, so a whole daemon can be faked without Docker.
type scriptedRunner struct {
	t       *testing.T
	answers map[string]string
	fails   map[string]string
	calls   []string
}

func (s *scriptedRunner) run(_ context.Context, name string, args []string, _ time.Duration) (string, string, error) {
	key := name + " " + strings.Join(args, " ")
	s.calls = append(s.calls, key)
	for prefix, stderr := range s.fails {
		if strings.HasPrefix(key, prefix) {
			return "", stderr, &CommandError{Name: name, Args: args, Stderr: stderr, Err: errors.New("exit status 1")}
		}
	}
	for prefix, out := range s.answers {
		if strings.HasPrefix(key, prefix) {
			return out, "", nil
		}
	}
	return "", "", &CommandError{Name: name, Args: args, Err: exec.ErrNotFound}
}

func TestTargetForIsDeterministicAndOpaque(t *testing.T) {
	a := TargetFor("chief-of-staff", "/tmp/computers")
	b := TargetFor("chief-of-staff", "/tmp/computers")
	c := TargetFor("Chief of Staff!", "/tmp/computers")
	if a != b {
		t.Fatalf("same slug must derive the same target")
	}
	if a.ContainerName == c.ContainerName {
		t.Fatalf("different slugs must not collide")
	}
	if strings.Contains(a.ContainerName, "chief") {
		t.Fatalf("container name must not embed the slug: %s", a.ContainerName)
	}
	if !strings.HasPrefix(a.ContainerName, ContainerPrefix+"-") || len(a.ContainerName) != len(ContainerPrefix)+1+16 {
		t.Fatalf("unexpected container name %q", a.ContainerName)
	}
	if filepath.Dir(a.WorkspaceDir) != "/tmp/computers" {
		t.Fatalf("workspace must live under the computers root: %s", a.WorkspaceDir)
	}
	if TargetFor("chief-of-staff", "/tmp/other").ContainerName == a.ContainerName {
		t.Fatalf("the same slug in another runtime home must get its own container")
	}
}

func TestDetectRuntimePrefersDaemonUp(t *testing.T) {
	r := &scriptedRunner{t: t, answers: map[string]string{
		"podman info": "5.1.0\n",
	}, fails: map[string]string{
		"docker info": "Cannot connect to the Docker daemon",
	}}
	got := DetectRuntime(context.Background(), r.run, "darwin")
	if got.Runtime != RuntimePodman || !got.DaemonUp {
		t.Fatalf("expected podman up, got %+v", got)
	}
	r = &scriptedRunner{t: t, fails: map[string]string{"docker info": "Cannot connect to the Docker daemon"}}
	got = DetectRuntime(context.Background(), r.run, "darwin")
	if got.Runtime != RuntimeDocker || got.DaemonUp || got.StartHint == "" {
		t.Fatalf("expected docker installed but down with a start hint, got %+v", got)
	}
	r = &scriptedRunner{t: t}
	got = DetectRuntime(context.Background(), r.run, "darwin")
	if got.Available || got.InstallHint == "" {
		t.Fatalf("expected no runtime with an install hint, got %+v", got)
	}
}

func TestManagedImageDockerfilePinsEverything(t *testing.T) {
	df := ManagedImageDockerfile()
	for _, want := range []string{BaseImageDigest, linuxWheels["x86_64"].SHA256, linuxWheels["aarch64"].SHA256, CuaExecutable, CuaSocket, ManagedLabel + "=\"1\"", "sha256sum -c -"} {
		if !strings.Contains(df, want) {
			t.Fatalf("Dockerfile missing %q", want)
		}
	}
	if out := os.Getenv("WUPHF_COMPUTER_DOCKERFILE_OUT"); out != "" {
		if err := os.WriteFile(out, []byte(df), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

func dockerInspectFixture(target Target, running bool, mutate func(m map[string]any)) string {
	pids := int64(512)
	host := map[string]any{
		"Memory": MemoryBytes, "MemorySwap": MemoryBytes, "NanoCpus": int64(CPUs) * 1_000_000_000,
		"PidsLimit": pids, "CapDrop": []string{"ALL"}, "CapAdd": []string{"SETUID", "SETGID"},
		"Privileged": false, "PidMode": "", "IpcMode": "private", "UTSMode": "", "ShmSize": ShmBytes,
		"Devices": []any{}, "DeviceRequests": nil, "SecurityOpt": nil, "UsernsMode": "", "CgroupnsMode": "private",
		"OomKillDisable": false, "AutoRemove": false, "RestartPolicy": map[string]any{"Name": "no"},
		"PortBindings": map[string]any{"6901/tcp": []map[string]string{{"HostIp": "127.0.0.1", "HostPort": ""}}},
	}
	m := map[string]any{
		"Image": "sha256:abc123",
		"State": map[string]any{"Running": running},
		"Config": map[string]any{
			"Image": Image,
			"Labels": map[string]string{ManagedLabel: "1", DriverLabel: CuaDriverVersion, BaseImageLabel: BaseImageDigest,
				LayerLabel: ImageLayerVersion, WorkspaceLabel: "1", TargetLabel: target.Label},
			"Env": []string{"VNC_PW=secret", "HOME=/home/cua"},
		},
		"HostConfig":      host,
		"NetworkSettings": map[string]any{"Ports": map[string]any{"6901/tcp": []map[string]string{{"HostIp": "127.0.0.1", "HostPort": "54321"}}}},
		"Mounts":          []map[string]any{{"Type": "bind", "Source": target.WorkspaceDir, "Destination": WorkspaceGuest, "RW": true}},
	}
	if mutate != nil {
		mutate(m)
	}
	out, _ := json.Marshal([]any{m})
	return string(out)
}

func imageInspectFixture() string {
	out, _ := json.Marshal([]any{map[string]any{
		"Id":     "sha256:abc123",
		"Config": map[string]any{"Labels": map[string]string{ManagedLabel: "1", DriverLabel: CuaDriverVersion, BaseImageLabel: BaseImageDigest, LayerLabel: ImageLayerVersion}},
	}})
	return string(out)
}

func TestInspectVerifiesAHealthyContainer(t *testing.T) {
	target := TargetFor("cos", t.TempDir())
	r := &scriptedRunner{t: t, answers: map[string]string{
		"docker image inspect":                   imageInspectFixture(),
		"docker inspect " + target.ContainerName: dockerInspectFixture(target, true, nil),
		"docker exec -u cua -e HOME=/home/cua -e DISPLAY=:1 -e CUA_DRIVER_INSTALL_CHANNEL=python_package -e CUA_DRIVER_RS_TELEMETRY_ENABLED=0 " + target.ContainerName + " " + CuaExecutable + " --version":          "cua-driver " + CuaDriverVersion + "\n",
		"docker exec -u cua -e HOME=/home/cua -e DISPLAY=:1 -e CUA_DRIVER_INSTALL_CHANNEL=python_package -e CUA_DRIVER_RS_TELEMETRY_ENABLED=0 " + target.ContainerName + " " + CuaExecutable + " status":             "ok",
		"docker exec -u cua -e HOME=/home/cua -e DISPLAY=:1 -e CUA_DRIVER_INSTALL_CHANNEL=python_package -e CUA_DRIVER_RS_TELEMETRY_ENABLED=0 " + target.ContainerName + " " + CuaExecutable + " call health_report": `{"schema_version":"1","overall":"ok","checks":[]}`,
	}}
	in := &Inspector{Run: r.run, Platform: "darwin"}
	rt := RuntimeStatus{Available: true, Runtime: RuntimeDocker, DaemonUp: true}
	s := in.Inspect(context.Background(), rt, target)
	if !s.Ready || s.Problem != "" {
		t.Fatalf("expected ready, got %+v", s)
	}
	if s.ViewerPort != 54321 || s.ViewerPassword != "secret" {
		t.Fatalf("viewer port/password not read: %+v", s)
	}
	// Second call is served from the readiness cache: no more exec calls.
	before := len(r.calls)
	_ = in.Inspect(context.Background(), rt, target)
	if len(r.calls) != before {
		t.Fatalf("expected cached readiness, got %d new calls", len(r.calls)-before)
	}
	in.Forget(target)
	_ = in.Inspect(context.Background(), rt, target)
	if len(r.calls) == before {
		t.Fatalf("Forget must invalidate the cache")
	}
}

func TestInspectRefusesTamperedContainers(t *testing.T) {
	target := TargetFor("cos", t.TempDir())
	cases := []struct {
		name   string
		mutate func(m map[string]any)
		want   string
	}{
		{"published beyond loopback", func(m map[string]any) {
			m["HostConfig"].(map[string]any)["PortBindings"] = map[string]any{"6901/tcp": []map[string]string{{"HostIp": "0.0.0.0", "HostPort": "6901"}}}
		}, "publishes a port"},
		{"privileged", func(m map[string]any) { m["HostConfig"].(map[string]any)["Privileged"] = true }, "safety limits"},
		{"host mount", func(m map[string]any) {
			m["Mounts"] = []map[string]any{{"Type": "bind", "Source": "/", "Destination": WorkspaceGuest, "RW": true}}
		}, "durable workspace"},
		{"foreign label", func(m map[string]any) {
			m["Config"].(map[string]any)["Labels"].(map[string]string)[TargetLabel] = "someone-else"
		}, "not created by gawkbot"},
		{"old image", func(m map[string]any) { m["Image"] = "sha256:old" }, "older desktop image"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := &scriptedRunner{t: t, answers: map[string]string{
				"docker image inspect":                   imageInspectFixture(),
				"docker inspect " + target.ContainerName: dockerInspectFixture(target, true, tc.mutate),
			}}
			in := &Inspector{Run: r.run, Platform: "darwin"}
			s := in.Inspect(context.Background(), RuntimeStatus{Available: true, Runtime: RuntimeDocker, DaemonUp: true}, target)
			if s.Ready || !strings.Contains(s.Problem, tc.want) {
				t.Fatalf("expected refusal mentioning %q, got %+v", tc.want, s)
			}
			for _, call := range r.calls {
				if strings.Contains(call, CuaExecutable) {
					t.Fatalf("must not probe the driver on a refused container: %s", call)
				}
			}
		})
	}
}

func TestManagerRunAndStopFlow(t *testing.T) {
	root := t.TempDir()
	target := TargetFor("cos", root)
	r := &scriptedRunner{t: t, answers: map[string]string{
		"docker image inspect": imageInspectFixture(),
		"docker run":           "containerid\n",
		"docker stop":          "",
	}}
	in := &Inspector{Run: r.run, Platform: "darwin"}
	m := &Manager{Run: r.run, Inspector: in, Platform: "darwin"}
	rt := RuntimeStatus{Available: true, Runtime: RuntimeDocker, DaemonUp: true}
	if _, err := m.Apply(context.Background(), rt, ActionStop, target); err == nil {
		t.Fatalf("stop on a missing container must be refused")
	}
	_, err := m.Apply(context.Background(), rt, ActionRun, target)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if st, err := os.Stat(target.WorkspaceDir); err != nil || !st.IsDir() {
		t.Fatalf("workspace dir must be created")
	}
	var runCall string
	for _, c := range r.calls {
		if strings.HasPrefix(c, "docker run") {
			runCall = c
		}
	}
	for _, want := range []string{"--cap-drop ALL", "--pids-limit 512", "--ipc private", "--cgroupns private", "-p 127.0.0.1::6901", "--memory 2048m", "--label " + TargetLabel + "=" + target.Label, "type=bind,source=" + target.WorkspaceDir + ",target=" + WorkspaceGuest, " " + Image} {
		if !strings.Contains(runCall, want) {
			t.Fatalf("run argv missing %q: %s", want, runCall)
		}
	}
	if strings.Contains(runCall, "VNC_PW= ") {
		t.Fatalf("run must set a non-empty VNC password")
	}
	var lerr *LifecycleError
	if _, err := m.Apply(context.Background(), rt, ActionRun, target); err == nil || !errors.As(err, &lerr) {
		r.answers["docker inspect "+target.ContainerName] = dockerInspectFixture(target, true, nil)
		if _, err := m.Apply(context.Background(), rt, ActionRun, target); err == nil || !errors.As(err, &lerr) || lerr.Status != http.StatusConflict {
			t.Fatalf("second run must 409, got %v", err)
		}
	}
}

func TestContainerRunArgsAppleNeedsFixedPort(t *testing.T) {
	target := TargetFor("cos", "/tmp/x")
	if _, err := ContainerRunArgs(RuntimeContainer, "pw", target, 0); err == nil {
		t.Fatalf("apple container without a host port must error")
	}
	args, err := ContainerRunArgs(RuntimeContainer, "pw", target, 60001)
	if err != nil || !strings.Contains(strings.Join(args, " "), "127.0.0.1:60001:6901") {
		t.Fatalf("unexpected apple args %v %v", args, err)
	}
}

func TestViewerSignerRoundTrip(t *testing.T) {
	signer := NewViewerSignerWithSecret([]byte("secret"))
	now := time.Unix(1_700_000_000, 0)
	token := signer.Token("cos", PolicyView, now)
	if !signer.Verify("cos", PolicyView, token, now.Add(30*time.Minute)) {
		t.Fatalf("fresh token must verify")
	}
	if signer.Verify("cos", PolicyControl, token, now) {
		t.Fatalf("view token must not grant control")
	}
	if signer.Verify("other", PolicyView, token, now) {
		t.Fatalf("token must be bound to the slug")
	}
	if signer.Verify("cos", PolicyView, token, now.Add(2*time.Hour)) {
		t.Fatalf("expired token must fail")
	}
	u := signer.ViewerURL("cos", PolicyView, "pw", now)
	if !strings.HasPrefix(u, ViewerPathPrefix+"cos/view/") || !strings.Contains(u, "view_only=true") || !strings.HasSuffix(u, "#password=pw") {
		t.Fatalf("unexpected viewer url %s", u)
	}
	if !strings.Contains(u, "path=computer-view%2Fcos%2Fview%2F") {
		t.Fatalf("websocket path must be origin-relative: %s", u)
	}
}

func TestViewerURLIsStableAcrossPolls(t *testing.T) {
	signer := NewViewerSignerWithSecret([]byte("secret"))
	// Stability is per window, so start on a boundary.
	now := time.Unix(1_700_000_000, 0).Truncate(ViewerWindow)
	first := signer.ViewerURL("cos", PolicyView, "pw", now)
	for _, later := range []time.Duration{5 * time.Second, 2 * time.Minute, ViewerWindow - time.Second} {
		if got := signer.ViewerURL("cos", PolicyView, "pw", now.Add(later)); got != first {
			t.Fatalf("viewer url changed after %s: the iframe would reconnect on every poll", later)
		}
	}
	token := signer.Token("cos", PolicyView, now.Add(ViewerWindow-time.Second))
	if !signer.Verify("cos", PolicyView, token, now.Add(ViewerWindow+ViewerTTL/2-time.Minute)) {
		t.Fatalf("a token minted at the end of its window must still carry half the TTL")
	}
}

func TestViewerProxyForwardsOnlyValidCapabilities(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("upstream " + r.URL.Path + "?" + r.URL.RawQuery + " ref=" + r.Header.Get("Referer")))
	}))
	defer upstream.Close()
	var port int
	if _, err := fmtSscanfPort(upstream.URL, &port); err != nil {
		t.Fatal(err)
	}
	signer := NewViewerSignerWithSecret([]byte("secret"))
	proxy := &ViewerProxy{Signer: signer, Resolve: func(slug string) (int, bool) {
		if slug == "cos" {
			return port, true
		}
		return 0, false
	}}
	base := signer.ViewerBase("cos", PolicyView, time.Now())
	req := httptest.NewRequest(http.MethodGet, base+"/vnc.html?autoconnect=true", nil)
	req.Header.Set("Referer", "http://app.local/agents/cos")
	rec := httptest.NewRecorder()
	proxy.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "upstream /vnc.html?autoconnect=true ref=") || strings.Contains(rec.Body.String(), "app.local") {
		t.Fatalf("expected proxied request without referer, got %d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	proxy.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, ViewerPathPrefix+"cos/view/123.bad/vnc.html", nil))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("bad token must 403, got %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	proxy.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, signer.ViewerBase("ghost", PolicyView, time.Now())+"/vnc.html", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown slug must 404, got %d", rec.Code)
	}
}

func fmtSscanfPort(u string, port *int) (int, error) {
	idx := strings.LastIndex(u, ":")
	n := 0
	for _, r := range u[idx+1:] {
		n = n*10 + int(r-'0')
	}
	*port = n
	return 1, nil
}

func TestControlRegistryRules(t *testing.T) {
	var events []string
	c := &Control{OnChange: func(slug string, s Snapshot) {
		events = append(events, slug+":"+boolStr(s.Held)+":"+boolStr(s.HelpOpen))
	}}
	id, s := c.RequestHelp("cos", "log in to Xero")
	if !s.HelpOpen || s.Held || id == "" {
		t.Fatalf("help must open without taking control: %+v", s)
	}
	s = c.Take("cos")
	if !s.Held || s.HelpOpen {
		t.Fatalf("take must hold and answer the plea: %+v", s)
	}
	if c.ExpireHelp("cos", id).Held != true {
		t.Fatalf("expiring an answered plea must not release the hold")
	}
	s = c.Release("cos")
	if s.Held {
		t.Fatalf("release must clear the hold")
	}
	if got := strings.Join(events, ","); got != "cos:false:true,cos:true:false,cos:false:false" {
		t.Fatalf("unexpected change events %s", got)
	}
	if c.Take("cos").Revision == c.Take("cos").Revision+1 {
		t.Fatalf("a repeated take must not bump the revision")
	}
}

func boolStr(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

func TestLeaseIsASingletonPerDesktop(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	l := NewLease(time.Minute)
	busy := func(string) bool { return true }
	if !l.Claim("turn-a", "cos", busy, now) {
		t.Fatalf("first claim must succeed")
	}
	if l.Claim("turn-b", "cos", busy, now) {
		t.Fatalf("second turn must be refused while the first is live")
	}
	if !l.Claim("turn-a", "cos", busy, now) {
		t.Fatalf("re-claim by the owner must succeed")
	}
	if !l.Claim("turn-b", "cos", busy, now.Add(2*time.Minute)) {
		t.Fatalf("an expired lease must be claimable")
	}
	l.Release("turn-b")
	if l.Current(busy, now.Add(2*time.Minute)) != nil {
		t.Fatalf("release must clear the lease")
	}
	if !l.Claim("turn-c", "cos", busy, now) {
		t.Fatal("claim")
	}
	if l.Current(func(string) bool { return false }, now) != nil {
		t.Fatalf("a lease whose owner stopped being busy must lapse")
	}
}

func TestIdleTimerSuspendsOnlyWhenIdle(t *testing.T) {
	var busy atomic.Bool
	busy.Store(true)
	suspended := make(chan struct{}, 4)
	timer := NewIdleTimer(20*time.Millisecond, func() bool { return busy.Load() }, func() error {
		suspended <- struct{}{}
		return nil
	})
	timer.Touch()
	select {
	case <-suspended:
		t.Fatalf("must not suspend while busy")
	case <-time.After(60 * time.Millisecond):
	}
	busy.Store(false)
	select {
	case <-suspended:
	case <-time.After(200 * time.Millisecond):
		t.Fatalf("expected suspend after idle window")
	}
	timer.Cancel()
}

func TestEncodePreviewDownscalesAndRejectsTruncated(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 1280, 900))
	for y := 0; y < 900; y++ {
		for x := 0; x < 1280; x++ {
			img.Set(x, y, color.RGBA{uint8(x), uint8(y), 128, 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	frame, err := EncodePreview(buf.Bytes(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(frame.DataURL, "data:image/jpeg;base64,") {
		t.Fatalf("expected jpeg data url")
	}
	raw, _ := base64.StdEncoding.DecodeString(strings.TrimPrefix(frame.DataURL, "data:image/jpeg;base64,"))
	decoded, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Bounds().Dx() != 640 || decoded.Bounds().Dy() != 450 {
		t.Fatalf("expected 640x450, got %v", decoded.Bounds())
	}
	if _, err := EncodePreview(buf.Bytes()[:buf.Len()/2], time.Now()); err == nil {
		t.Fatalf("truncated PNG must be rejected")
	}
}

func TestGateInterceptorRefusesWhileHeldAndAddsHelpTool(t *testing.T) {
	held := true
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(w).Encode(Snapshot{Held: held})
	}))
	defer srv.Close()
	var forwarded, emitted []string
	g := &gateInterceptor{
		gate:    &GateClient{URL: srv.URL, Token: "tok"},
		forward: func(l string) { forwarded = append(forwarded, l) },
		emit:    func(l string) { emitted = append(emitted, l) },
		listIDs: map[string]bool{},
	}
	ctx := context.Background()
	g.fromBot(ctx, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`)
	g.fromBot(ctx, `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"click","arguments":{}}}`)
	if len(forwarded) != 1 || len(emitted) != 1 || !strings.Contains(emitted[0], `"isError":true`) || !strings.Contains(emitted[0], `"id":2`) {
		t.Fatalf("held: expected initialize forwarded and click refused, got fwd=%v emit=%v", forwarded, emitted)
	}
	held = false
	g.fromBot(ctx, `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"click","arguments":{}}}`)
	if len(forwarded) != 2 {
		t.Fatalf("released: click must be forwarded")
	}
	g.fromBot(ctx, `{"jsonrpc":"2.0","id":4,"method":"tools/list"}`)
	g.fromChild(`{"jsonrpc":"2.0","id":4,"result":{"tools":[{"name":"click"}]}}`)
	last := emitted[len(emitted)-1]
	if !strings.Contains(last, HelpToolName) || !strings.Contains(last, `"name":"click"`) {
		t.Fatalf("tools/list response must gain the help tool: %s", last)
	}
	g.fromChild(`{"jsonrpc":"2.0","id":9,"result":{"content":[]}}`)
	if emitted[len(emitted)-1] != `{"jsonrpc":"2.0","id":9,"result":{"content":[]}}` {
		t.Fatalf("unrelated responses must pass through byte-for-byte")
	}
	g.fromBot(ctx, "not json at all")
	if forwarded[len(forwarded)-1] != "not json at all" {
		t.Fatalf("non-JSON lines must be forwarded untouched")
	}
}

func TestValidBridgeArgs(t *testing.T) {
	if err := ValidBridgeArgs("docker", "gawkbot-computer-abc", CuaSocket); err != nil {
		t.Fatal(err)
	}
	for _, bad := range [][3]string{{"lxc", "x", CuaSocket}, {"docker", "../x", CuaSocket}, {"docker", "x", "/tmp/sock"}} {
		if err := ValidBridgeArgs(bad[0], bad[1], bad[2]); err == nil {
			t.Fatalf("expected rejection for %v", bad)
		}
	}
}
