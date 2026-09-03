package team

// launcher_reconfigure.go owns the runtime-reconfiguration flow
// (PLAN.md §C20). When the user adds/removes bots mid-session
// (via the channel TUI, the office-reseeded broker event, or the
// CLI 'reconfigure' subcommand), the launcher needs to:
//   1. Re-resolve the LLM provider from config (it may have changed)
//   2. Decide whether the new roster is pane-runtime or headless
//   3. Tear down the old panes and respawn against the new roster,
//      preserving the channel pane and pane sizes when possible
//   4. Re-seed the headless workers
//
// reconfigureVisibleBots is the heavy method (~90 lines) that
// drives steps 2-4. ReconfigureSession is its public entry point.
// respawnPanesAfterReseed is the office_reseeded notification
// handler that triggers the same flow when the broker pushes a
// roster change.

import (
	"fmt"
	"log"
	"os"
	"strings"

	"github.com/nex-crm/wuphf/internal/config"
	"github.com/nex-crm/wuphf/internal/provider"
)

// respawnPanesAfterReseed restarts the interactive bot panes so they match
// the newly-seeded roster from onboarding. Best-effort: the codex runtime has
// no interactive panes, and reconfigureVisibleBots handles an uninitialised
// paneBackedBots state by no-op'ing. Errors are logged but do not propagate
// — failing to respawn leaves the previous panes running (degraded, but the
// headless path can still deliver).
func (l *Launcher) respawnPanesAfterReseed() {
	if l == nil {
		return
	}
	l.provider = config.ResolveLLMProvider("")
	if err := l.reconfigureVisibleBots(); err != nil {
		// "No tmux server running" / "can't find session" are the expected
		// states when the launcher runs in headless/web mode without a
		// persistent tmux session — reconfigureVisibleBots tries to
		// attach, fails, and the headless dispatch path takes over silently.
		// Logging it as an error makes a normal code path look like a
		// recurring failure in the console. Uses the canonical tmux-error
		// classifier (isMissingTmuxSession) so this path stays consistent
		// with every other tmux-attach site. Real failures (permission
		// denied, exec-not-found with no tmux prefix) keep logging.
		if isMissingTmuxSession(err.Error()) {
			return
		}
		log.Printf("office_reseeded: respawn panes failed: %v", err)
	}
}

func (l *Launcher) ReconfigureSession() error {
	if !l.targeter().UsesPaneRuntime() {
		if err := provider.ResetClaudeSessions(); err != nil {
			return fmt.Errorf("reset Claude sessions: %w", err)
		}
		if err := l.panes().ClearBotPanes(); err != nil {
			return err
		}
		l.panes().ClearOverflowBotWindows()
		return nil
	}
	return l.reconfigureVisibleBots()
}

func (l *Launcher) reconfigureVisibleBots() error {
	l.provider = config.ResolveLLMProvider("")
	if !l.targeter().UsesPaneRuntime() {
		if l.paneBackedBots {
			l.panes().KillSession()
			l.paneBackedBots = false
		}
		return nil
	}

	mcpConfig, err := l.ensureMCPConfig()
	if err != nil {
		return fmt.Errorf("prepare mcp config: %w", err)
	}
	l.mcpConfig = mcpConfig

	if err := provider.ResetClaudeSessions(); err != nil {
		return fmt.Errorf("reset Claude sessions: %w", err)
	}

	// Drop every recorded failure under the mutex so a concurrent
	// reader (officeTargeter via the failedPaneSlugs callback)
	// observes either the pre-reconfigure full map or the
	// post-reconfigure empty map — never a torn intermediate state.
	// Clear the existing map in place rather than nil-then-rebuild so
	// the targeter (which reads via the callback returning
	// l.failedPaneSlugs) keeps seeing the same map handle across the
	// reconfigure boundary.
	l.failedPaneMu.Lock()
	if l.failedPaneSlugs == nil {
		l.failedPaneSlugs = make(map[string]string)
	} else {
		clear(l.failedPaneSlugs)
	}
	l.failedPaneMu.Unlock()

	// Use respawn-pane to restart bot processes IN PLACE.
	// This preserves pane sizes and positions (no layout reset).
	panes, err := l.panes().ListTeamPanes()
	if err != nil {
		return err
	}
	l.panes().ClearOverflowBotWindows()

	// Respawn each bot pane in place, preserving layout.
	// Never clear+recreate panes — that destroys the channel's layout.
	visibleMembers := l.targeter().VisibleMembers()
	if len(panes) != len(visibleMembers) {
		if err := l.panes().ClearBotPanes(); err != nil {
			return err
		}
		if _, err := l.panes().SpawnVisibleBots(); err != nil {
			return err
		}
		l.panes().SpawnOverflowBots()
		go l.panes().DetectDeadPanesAfterSpawn(visibleMembers)
		if l.broker != nil {
			go l.primeVisibleBots()
		}
		return nil
	}

	for _, idx := range panes {
		// Map pane index to bot slug (pane 1 = first bot, etc.)
		slugIdx := idx - 1 // pane 0 is channel
		if slugIdx < 0 || slugIdx >= len(visibleMembers) {
			continue
		}
		slug := visibleMembers[slugIdx].Slug
		cmd, err := l.claudeCommand(slug, l.buildPrompt(slug))
		if err != nil {
			fmt.Fprintf(os.Stderr, "respawn pane for %s: %v\n", slug, err)
			l.recordPaneSpawnFailure(slug, fmt.Sprintf("claudeCommand: %v", err))
			continue
		}

		// respawn-pane -k kills the current process and starts a new one
		// in the same pane — preserving size and position
		out, err := l.panes().RespawnBotPane(idx, l.cwd, cmd)
		if err != nil {
			detail := strings.TrimSpace(string(out))
			reason := err.Error()
			if detail != "" {
				reason = fmt.Sprintf("%s (tmux: %s)", reason, detail)
			}
			fmt.Fprintf(os.Stderr,
				"  Bots:  respawn-pane for %s failed (%s); falling back to headless\n",
				slug, reason,
			)
			l.recordPaneSpawnFailure(slug, reason)
		}
	}
	l.panes().SpawnOverflowBots()
	go l.panes().DetectDeadPanesAfterSpawn(visibleMembers)

	if l.broker != nil {
		go l.primeVisibleBots()
	}

	return nil
}
