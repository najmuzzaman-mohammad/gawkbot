package team

// agent_service_supervisor.go — the broker owns the operator agent service.
//
// Routine fires (scheduler_operator_routines.go) and the operator's tool
// authoring both POST to the pi-mono agent service (agent/ package, :8820).
// Until now NOTHING started that service: a standard install failed every
// routine fire with "agent service unreachable" — the runs-24x7 pillar
// depended on a sidecar the user had to discover and start by hand (found in
// the 2026-08-14 QA pass; founder decision: the broker spawns it).
//
// Resolution order:
//  1. WUPHF_AGENT_URL set → externally managed; never spawn.
//  2. Something already listens on the agent port → adopt it; never spawn.
//  3. A runnable service dir exists (WUPHF_AGENT_DIR, or agent/ next to the
//     repo/binary) AND bun is on PATH → spawn `bun run src/service.ts`,
//     supervise with restart-on-exit + backoff, kill on broker Stop.
//  4. Otherwise log once. The fire-time error copy still names the fix.
//
// Packaging the service into the npx/desktop distributions is tracked as a
// follow-up; this supervisor makes every source checkout and dev install
// behave, and adopts any packaged service the moment one exists.

import (
	"context"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// agentServiceSpawnBackoff is the restart delay after the child exits. Kept
// long enough that a crash-looping service (missing deps, bad node) does not
// churn the machine, short enough that a transient crash self-heals.
const agentServiceSpawnBackoff = 15 * time.Second

// startAgentServiceSupervisor launches the supervision goroutine. Idempotent
// per broker instance; safe to call when nothing is resolvable (logs once).
func (b *Broker) startAgentServiceSupervisor(ctx context.Context) {
	if strings.TrimSpace(os.Getenv("WUPHF_AGENT_URL")) != "" {
		log.Printf("agent-service: WUPHF_AGENT_URL set — externally managed, not spawning")
		return
	}
	dir := resolveAgentServiceDir()
	bunPath, bunErr := exec.LookPath("bun")
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			default:
			}
			if agentServiceListening(ctx) {
				// Adopted (or our previous child is healthy). Re-check on a
				// slow tick; cheap dial, no HTTP.
				select {
				case <-ctx.Done():
					return
				case <-time.After(agentServiceSpawnBackoff):
				}
				continue
			}
			if dir == "" || bunErr != nil {
				if dir == "" {
					log.Printf("agent-service: no service dir found (set WUPHF_AGENT_DIR or run from a checkout) — routines need it to fire")
				} else {
					log.Printf("agent-service: bun not on PATH — cannot start %s", dir)
				}
				return
			}
			log.Printf("agent-service: starting %s (bun run src/service.ts)", dir)
			cmd := exec.CommandContext(ctx, bunPath, "run", "src/service.ts")
			cmd.Dir = dir
			cmd.Env = append(os.Environ(), "PORT="+agentServicePort())
			// The child logs into the runtime home so `wuphf log`-style
			// debugging finds it next to the broker's own logs.
			if f, err := agentServiceLogFile(); err == nil {
				cmd.Stdout = f
				cmd.Stderr = f
			}
			if err := cmd.Start(); err != nil {
				log.Printf("agent-service: start failed: %v", err)
				return
			}
			err := cmd.Wait()
			select {
			case <-ctx.Done():
				return
			default:
			}
			log.Printf("agent-service: exited (%v) — restarting in %s", err, agentServiceSpawnBackoff)
			select {
			case <-ctx.Done():
				return
			case <-time.After(agentServiceSpawnBackoff):
			}
		}
	}()
}

// agentServicePort extracts the port from operatorAgentBaseURL ("8820").
func agentServicePort() string {
	base := operatorAgentBaseURL()
	if i := strings.LastIndex(base, ":"); i >= 0 && i < len(base)-1 {
		return base[i+1:]
	}
	return "8820"
}

// agentServiceListening reports whether anything accepts TCP on the agent port.
func agentServiceListening(ctx context.Context) bool {
	dialCtx, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
	defer cancel()
	var d net.Dialer
	conn, err := d.DialContext(dialCtx, "tcp", "127.0.0.1:"+agentServicePort())
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

// resolveAgentServiceDir finds a runnable agent/ package: WUPHF_AGENT_DIR
// first, then agent/ beside the working directory, then beside the binary.
func resolveAgentServiceDir() string {
	candidates := []string{}
	if v := strings.TrimSpace(os.Getenv("WUPHF_AGENT_DIR")); v != "" {
		candidates = append(candidates, v)
	}
	if wd, err := os.Getwd(); err == nil {
		candidates = append(candidates, filepath.Join(wd, "agent"))
	}
	if exe, err := os.Executable(); err == nil {
		candidates = append(candidates, filepath.Join(filepath.Dir(exe), "agent"))
	}
	for _, dir := range candidates {
		if st, err := os.Stat(filepath.Join(dir, "src", "service.ts")); err == nil && !st.IsDir() {
			return dir
		}
	}
	return ""
}

// agentServiceLogFile opens (append) the child's log next to the broker's
// other logs (~/.wuphf/logs, honoring the runtime-home override).
func agentServiceLogFile() (*os.File, error) {
	dir := wuphfLogDir()
	if dir == "" {
		return nil, os.ErrNotExist
	}
	return os.OpenFile(filepath.Join(dir, "agent-service.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
}

// agentServiceHealthy is a stricter probe for callers that want HTTP health,
// kept for future use by a status surface.
func agentServiceHealthy(ctx context.Context) bool {
	reqCtx, cancel := context.WithTimeout(ctx, 1*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, operatorAgentBaseURL()+"/health", nil)
	if err != nil {
		return false
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return false
	}
	_ = resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}
