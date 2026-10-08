package agentdetect

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

type fakeInfo struct{ os.FileInfo }

func fakeScanner(bins map[string]string, configs map[string]bool, procs []rawProcess, self int) *Scanner {
	return &Scanner{
		LookPath: func(name string) (string, error) {
			if p, ok := bins[name]; ok {
				return p, nil
			}
			return "", exec.ErrNotFound
		},
		Stat: func(path string) (os.FileInfo, error) {
			if configs[path] {
				return fakeInfo{}, nil
			}
			return nil, os.ErrNotExist
		},
		Home:      func() (string, error) { return "/home/u", nil },
		Processes: func(context.Context) ([]rawProcess, error) { return procs, nil },
		SelfPID:   self,
	}
}

func byID(t *testing.T, ds []Detection, id string) Detection {
	t.Helper()
	for _, d := range ds {
		if d.ID == id {
			return d
		}
	}
	t.Fatalf("no detection for %q", id)
	return Detection{}
}

func TestScanFindsInstalledConfiguredAndRunningAgents(t *testing.T) {
	s := fakeScanner(
		map[string]string{"claude": "/usr/local/bin/claude", "gemini": "/opt/bin/gemini"},
		map[string]bool{filepath.Join("/home/u", ".codex"): true},
		[]rawProcess{
			{PID: 10, PPID: 1, Args: []string{"/usr/local/bin/claude", "--resume"}, Cwd: "/src/app"},
			{PID: 11, PPID: 1, Args: []string{"node", "/usr/lib/node_modules/@google/gemini-cli/dist/index.js"}},
			{PID: 12, PPID: 1, Args: []string{"/usr/bin/python3", "/home/u/.local/bin/aider", "--model", "x"}},
			{PID: 13, PPID: 1, Args: []string{"vim", "claude.md"}},
		},
		0,
	)
	got := s.Scan(context.Background())
	if len(got) != len(catalog) {
		t.Fatalf("Scan returned %d detections, want one per catalog entry (%d)", len(got), len(catalog))
	}

	claude := byID(t, got, "claude-code")
	if !claude.Installed || claude.BinaryPath != "/usr/local/bin/claude" {
		t.Fatalf("claude not detected as installed: %+v", claude)
	}
	if len(claude.Running) != 1 || claude.Running[0].PID != 10 || claude.Running[0].Cwd != "/src/app" {
		t.Fatalf("claude running = %+v, want pid 10 in /src/app", claude.Running)
	}
	if claude.ProviderKind != "claude-code" || !claude.Adoptable {
		t.Fatalf("claude should adopt onto claude-code: %+v", claude)
	}

	codex := byID(t, got, "codex")
	if codex.Installed || codex.ConfigPath != filepath.Join("/home/u", ".codex") || !codex.Found() {
		t.Fatalf("codex should be found by config only: %+v", codex)
	}

	gemini := byID(t, got, "gemini")
	if !gemini.Installed || len(gemini.Running) != 1 || gemini.Running[0].PID != 11 {
		t.Fatalf("gemini should be installed and running via node marker: %+v", gemini)
	}
	if gemini.ProviderKind != ProviderKindCLIAgent {
		t.Fatalf("gemini provider kind = %q, want %q", gemini.ProviderKind, ProviderKindCLIAgent)
	}

	aider := byID(t, got, "aider")
	if len(aider.Running) != 1 || aider.Running[0].PID != 12 {
		t.Fatalf("aider under python should be detected running: %+v", aider)
	}

	// "vim claude.md" must not count as a running Claude.
	for _, d := range got {
		for _, p := range d.Running {
			if p.PID == 13 {
				t.Fatalf("%s matched an unrelated process (vim)", d.ID)
			}
		}
	}

	if byID(t, got, "goose").Found() {
		t.Fatalf("goose has no binary, config, or process and must not be found")
	}
}

func TestScanExcludesTheOfficesOwnBotTurns(t *testing.T) {
	const self = 100
	s := fakeScanner(nil, nil, []rawProcess{
		{PID: self, PPID: 1, Args: []string{"gawkbot"}},
		{PID: 101, PPID: self, Args: []string{"claude", "-p", "turn"}},
		{PID: 102, PPID: 101, Args: []string{"node", "@openai/codex"}},
		{PID: 200, PPID: 1, Args: []string{"claude"}},
	}, self)
	got := s.Scan(context.Background())
	claude := byID(t, got, "claude-code")
	if len(claude.Running) != 1 || claude.Running[0].PID != 200 {
		t.Fatalf("claude running = %+v, want only the user's own session (pid 200)", claude.Running)
	}
	if n := len(byID(t, got, "codex").Running); n != 0 {
		t.Fatalf("codex grandchild of the office was reported running (%d)", n)
	}
}

func TestScanSurvivesProcessListingFailure(t *testing.T) {
	s := fakeScanner(map[string]string{"codex": "/bin/codex"}, nil, nil, 0)
	s.Processes = func(context.Context) ([]rawProcess, error) { return nil, errors.New("boom") }
	codex := byID(t, s.Scan(context.Background()), "codex")
	if !codex.Installed || len(codex.Running) != 0 {
		t.Fatalf("codex = %+v, want installed with no running info", codex)
	}
}

func TestExcludeDescendantsToleratesCycles(t *testing.T) {
	procs := []rawProcess{{PID: 5, PPID: 6}, {PID: 6, PPID: 5}, {PID: 7, PPID: 9}}
	done := make(chan []rawProcess, 1)
	go func() { done <- excludeDescendants(procs, 9) }()
	select {
	case got := <-done:
		if len(got) != 2 {
			t.Fatalf("got %d processes, want the two cycle members kept and pid 7 dropped", len(got))
		}
	case <-time.After(2 * time.Second):
		t.Fatal("excludeDescendants hung on a parent cycle")
	}
}

func TestHeadlessArgv(t *testing.T) {
	spec, ok := Lookup("gemini")
	if !ok {
		t.Fatal("gemini missing from catalog")
	}
	args, ok := spec.HeadlessArgv("gemini-2.5-pro", "do the thing; rm -rf /")
	if !ok {
		t.Fatal("gemini should have a headless mode")
	}
	want := []string{"-m", "gemini-2.5-pro", "-p", "do the thing; rm -rf /"}
	if len(args) != len(want) {
		t.Fatalf("args = %q, want %q", args, want)
	}
	for i := range want {
		if args[i] != want[i] {
			t.Fatalf("args = %q, want %q", args, want)
		}
	}

	amp, _ := Lookup("amp")
	args, _ = amp.HeadlessArgv("ignored-no-flag", "hi")
	if len(args) != 2 || args[0] != "-x" || args[1] != "hi" {
		t.Fatalf("amp args = %q, want [-x hi] (no model flag)", args)
	}

	cursor, _ := Lookup("cursor")
	if _, ok := cursor.HeadlessArgv("", "hi"); ok {
		t.Fatal("the Cursor IDE has no headless mode")
	}
}

func TestCatalogInvariants(t *testing.T) {
	seen := map[string]bool{}
	for _, s := range Catalog() {
		if s.ID == "" || s.Name == "" || len(s.Binaries) == 0 {
			t.Fatalf("incomplete spec: %+v", s)
		}
		if seen[s.ID] {
			t.Fatalf("duplicate catalog id %q", s.ID)
		}
		seen[s.ID] = true
		switch s.Runtime {
		case RuntimeNative:
			if s.ProviderKind == "" || s.Headless != nil {
				t.Fatalf("%s: native agents need a provider kind and no headless spec", s.ID)
			}
		case RuntimeCLI:
			if s.Headless == nil {
				t.Fatalf("%s: cli agents need a headless spec", s.ID)
			}
			n := 0
			for _, a := range s.Headless.Args {
				if a == PromptPlaceholder {
					n++
				}
			}
			if n != 1 {
				t.Fatalf("%s: headless args must contain exactly one %s, got %d", s.ID, PromptPlaceholder, n)
			}
		case RuntimeGateway, RuntimeApp:
			if s.Adoptable() {
				t.Fatalf("%s: gateways and apps must not be adoptable", s.ID)
			}
		default:
			t.Fatalf("%s: unknown runtime %q", s.ID, s.Runtime)
		}
	}
	for _, id := range []string{"claude-code", "codex", "opencode", "gemini"} {
		if !seen[id] {
			t.Fatalf("catalog is missing %q", id)
		}
	}
}

func TestParsePSOutput(t *testing.T) {
	got := parsePSOutput("  10     1 /usr/local/bin/claude --resume\n 11 10 node /x/@openai/codex/bin/codex.js\nbad line\n\n")
	if len(got) != 2 {
		t.Fatalf("parsed %d processes, want 2: %+v", len(got), got)
	}
	if got[0].PID != 10 || got[0].PPID != 1 || got[0].Args[0] != "/usr/local/bin/claude" {
		t.Fatalf("first = %+v", got[0])
	}
	if got[1].PPID != 10 || len(got[1].Args) != 2 {
		t.Fatalf("second = %+v", got[1])
	}
}
