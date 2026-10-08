package agentdetect

import (
	"context"
	"os"
	"path/filepath"
	"strings"

	"github.com/nex-crm/wuphf/internal/runtimebin"
)

// Process is one running instance of a detected agent.
type Process struct {
	PID int `json:"pid"`
	// Cwd is the directory the agent is working in, when the OS exposes it
	// (Linux /proc). It tells the user which project each session is on.
	Cwd string `json:"cwd,omitempty"`
}

// Detection is the scan result for one catalog entry.
type Detection struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	Vendor     string    `json:"vendor,omitempty"`
	Runtime    Runtime   `json:"runtime"`
	Installed  bool      `json:"installed"`
	BinaryPath string    `json:"binary_path,omitempty"`
	ConfigPath string    `json:"config_path,omitempty"`
	Running    []Process `json:"running,omitempty"`
	Adoptable  bool      `json:"adoptable"`
	// ProviderKind is the gawkbot provider an adopted bot binds to:
	// the native kind, or "cli-agent" for headless CLIs.
	ProviderKind string `json:"provider_kind,omitempty"`
	InstallURL   string `json:"install_url,omitempty"`
	Note         string `json:"note,omitempty"`
}

// Found reports whether anything about the agent was seen on this machine.
func (d Detection) Found() bool {
	return d.Installed || d.ConfigPath != "" || len(d.Running) > 0
}

// rawProcess is the OS-neutral process listing entry the platform listers
// produce.
type rawProcess struct {
	PID  int
	PPID int
	Args []string
	Cwd  string
}

// Scanner holds the OS hooks a scan uses so tests can substitute them.
type Scanner struct {
	LookPath  func(name string) (string, error)
	Stat      func(path string) (os.FileInfo, error)
	Home      func() (string, error)
	Processes func(ctx context.Context) ([]rawProcess, error)
	// SelfPID anchors the "spawned by gawkbot" filter: processes descended
	// from it are the office's own bot turns, not agents to adopt.
	SelfPID int
}

// NewScanner returns a Scanner wired to the real OS.
func NewScanner() *Scanner {
	return &Scanner{
		LookPath:  runtimebin.LookPath,
		Stat:      os.Stat,
		Home:      os.UserHomeDir,
		Processes: listProcesses,
		SelfPID:   os.Getpid(),
	}
}

// Scan checks every catalog entry and returns one Detection per entry, in
// catalog order. A failed process listing degrades to "no running
// instances" rather than failing the scan: install/config detection is still
// useful on its own.
func (s *Scanner) Scan(ctx context.Context) []Detection {
	home := ""
	if s.Home != nil {
		if h, err := s.Home(); err == nil {
			home = strings.TrimSpace(h)
		}
	}
	var procs []rawProcess
	if s.Processes != nil {
		if list, err := s.Processes(ctx); err == nil {
			procs = excludeDescendants(list, s.SelfPID)
		}
	}

	out := make([]Detection, 0, len(catalog))
	for _, spec := range catalog {
		d := Detection{
			ID:         spec.ID,
			Name:       spec.Name,
			Vendor:     spec.Vendor,
			Runtime:    spec.Runtime,
			Adoptable:  spec.Adoptable(),
			InstallURL: spec.InstallURL,
			Note:       spec.Note,
		}
		switch spec.Runtime {
		case RuntimeNative:
			d.ProviderKind = spec.ProviderKind
		case RuntimeCLI:
			d.ProviderKind = ProviderKindCLIAgent
		}
		for _, bin := range spec.Binaries {
			if s.LookPath == nil {
				break
			}
			if path, err := s.LookPath(bin); err == nil {
				d.Installed = true
				d.BinaryPath = path
				break
			}
		}
		if home != "" && s.Stat != nil {
			for _, rel := range spec.ConfigPaths {
				p := filepath.Join(home, filepath.FromSlash(rel))
				if _, err := s.Stat(p); err == nil {
					d.ConfigPath = p
					break
				}
			}
		}
		for _, p := range procs {
			if matchesProcess(spec, p.Args) {
				d.Running = append(d.Running, Process{PID: p.PID, Cwd: p.Cwd})
			}
		}
		// A binary that only shows up as a running process is still
		// usable: the user launched it from somewhere off our PATH.
		// Adoption needs a resolvable binary, so it stays Installed=false.
		out = append(out, d)
	}
	return out
}

// ProviderKindCLIAgent mirrors provider.KindCLIAgent. Duplicated as a
// constant so this package stays free of the provider package's
// dependencies; a test pins the two together.
const ProviderKindCLIAgent = "cli-agent"

// interpreters host agents shipped as scripts (npm packages run by node,
// pip packages run by python). For these, argv[0] is the interpreter and the
// agent is identified by argv[1] or a package marker.
var interpreters = map[string]bool{
	"node": true, "nodejs": true, "bun": true, "deno": true,
	"python": true, "python3": true,
}

func matchesProcess(spec Spec, args []string) bool {
	if len(args) == 0 {
		return false
	}
	exe := execBase(args[0])
	for _, bin := range spec.Binaries {
		if exe == bin {
			return true
		}
	}
	if !interpreters[exe] && !strings.HasPrefix(exe, "python3.") {
		return false
	}
	if len(args) > 1 {
		script := execBase(args[1])
		for _, bin := range spec.Binaries {
			if script == bin {
				return true
			}
		}
	}
	joined := strings.Join(args[1:], " ")
	for _, marker := range spec.ProcessMarkers {
		if marker != "" && strings.Contains(joined, marker) {
			return true
		}
	}
	return false
}

// execBase is the executable name without directory or a Windows ".exe".
func execBase(arg string) string {
	base := filepath.Base(strings.ReplaceAll(arg, "\\", "/"))
	return strings.TrimSuffix(strings.ToLower(base), ".exe")
}

// excludeDescendants drops self and every process descended from it, so the
// bot turns the office itself is running never show up as "agents running
// on this machine".
func excludeDescendants(procs []rawProcess, self int) []rawProcess {
	if self <= 0 {
		return procs
	}
	parent := make(map[int]int, len(procs))
	for _, p := range procs {
		parent[p.PID] = p.PPID
	}
	descends := func(pid int) bool {
		// Bounded walk: a malformed table with a cycle cannot spin forever.
		for i := 0; i < 64 && pid > 1; i++ {
			if pid == self {
				return true
			}
			next, ok := parent[pid]
			if !ok || next == pid {
				return false
			}
			pid = next
		}
		return false
	}
	out := procs[:0:0]
	for _, p := range procs {
		if descends(p.PID) {
			continue
		}
		out = append(out, p)
	}
	return out
}
