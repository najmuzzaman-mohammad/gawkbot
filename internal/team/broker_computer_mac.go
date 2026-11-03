package team

// broker_computer_mac.go: the person's own Mac as a bot's computer. The
// mount hands the turn a bridge into the app-owned driver socket with the
// bot's own cursor session; the first action of a turn asks the person in
// the notch unless they chose to always allow it; the notch shows that ask
// as a card with one-tap answers.

import (
	"context"
	"errors"
	"os"
	"strings"
	"time"

	"github.com/nex-crm/wuphf/internal/computer"
	"github.com/nex-crm/wuphf/internal/config"
)

// computerMac is the destination value for the person's own Mac.
const computerMac = "mac"

// consentCardPrefix marks the notch card for a bot waiting to be allowed.
const consentCardPrefix = "consent:"

// macComputerProblem says why a bot cannot use the Mac right now, or "".
func (b *Broker) macComputerProblem(ctx context.Context) string {
	hc := b.hostComputerInstalled()
	if hc == nil {
		return "Using this Mac needs the gawkbot app open"
	}
	if st := hc.Status(); !st.Ready {
		return st.Problem
	}
	perms, ok := b.hostPermissions(ctx, time.Now())
	if !ok {
		return "the computer-use driver is not answering"
	}
	if !perms.Accessibility || !perms.ScreenRecording {
		return "gawkbot needs Accessibility and Screen Recording to use this Mac; the notch asks for them"
	}
	return ""
}

// mountMacForTurn gives the turn hands on the Mac, or reports why not.
func (s *computerService) mountMacForTurn(ctx context.Context, slug, turnID, taskID, controlURL, controlToken string) (*computerMount, error) {
	if problem := s.b.macComputerProblem(ctx); problem != "" {
		s.setState(slug, "unavailable", problem)
		return nil, nil
	}
	hc := s.b.hostComputerInstalled()
	driver, socket, ok := hc.DriverPath()
	if !ok {
		s.setState(slug, "unavailable", "the computer-use driver is not answering")
		return nil, nil
	}
	binary, err := os.Executable()
	if err != nil {
		return nil, err
	}
	launch := computer.HostMCPLaunch(binary, driver, socket, slug, computer.ControlEndpoint{URL: controlURL, Token: controlToken})
	m, _ := s.member(slug)
	launch.Env["GAWKBOT_BOT_LABEL"] = strings.TrimSpace(firstNonEmpty(m.Name, slug))
	if m.Avatar != nil && m.Avatar.Color != "" {
		launch.Env["GAWKBOT_BOT_COLOR"] = m.Avatar.Color
	}
	cfg, _ := config.Load()
	if cfg.IsMacComputerAlwaysAllowed() {
		launch.Env["GAWKBOT_MAC_ALWAYS_ALLOW"] = "1"
	}
	mount := &computerMount{slug: slug, turnID: turnID, taskID: taskID, Launch: launch, mac: true}
	s.mu.Lock()
	s.turnEnv[slug] = launch.Env
	s.mu.Unlock()
	s.setState(slug, "ready", "")
	return mount, nil
}

// decideConsent records the person's answer for a bot on the Mac. "Always"
// also flips the one setting, so no later turn asks.
func (b *Broker) decideConsent(slug, decision string) (computer.Snapshot, error) {
	switch decision {
	case computer.ConsentAllow, computer.ConsentAllowAlways, computer.ConsentDeny:
	default:
		return computer.Snapshot{}, errors.New("decision must be allow, allow_always, or deny")
	}
	if decision == computer.ConsentAllowAlways {
		b.configMu.Lock()
		cfg, _ := config.Load()
		v := true
		cfg.MacComputerAlwaysAllow = &v
		_ = config.Save(cfg)
		b.configMu.Unlock()
	}
	return b.computers().control.Decide(slug, decision), nil
}

// withNotchHostWanted says whether any bot is set to run on this Mac.
func (b *Broker) withNotchHostWanted(state notchState, owner bool) notchState {
	if !owner {
		return state
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, m := range b.members {
		if strings.TrimSpace(m.Computer) == computerMac {
			state.HostWanted = true
			break
		}
	}
	return state
}

// withNotchConsents puts a card at the front of Needs-you for every bot on
// the Mac waiting to be allowed. The card answers through
// POST /computer/{slug}/control, not /requests/answer.
func (b *Broker) withNotchConsents(state notchState, owner bool) notchState {
	if !owner {
		return state
	}
	control := b.computers().control
	var cards []notchAttention
	for _, a := range state.Agents {
		if a.Kind == "session" {
			continue
		}
		snap := control.Snapshot(a.Slug)
		if !snap.ConsentOpen {
			continue
		}
		summary := "wants to use this Mac"
		if snap.ConsentSummary != nil {
			summary = *snap.ConsentSummary
		}
		cards = append(cards, notchAttention{
			ID:       consentCardPrefix + a.Slug,
			Kind:     "computer_consent",
			From:     a.Slug,
			FromName: a.Name,
			Title:    "Wants to use this Mac",
			Question: a.Name + " " + summary + ". Allow it this turn?",
			Context:  "It works with its own cursor, which you can watch, and never moves yours. ⌥Esc stops every agent at once.",
			Options: []notchOption{
				{ID: computer.ConsentAllow, Label: "Allow this turn"},
				{ID: computer.ConsentAllowAlways, Label: "Always allow", Description: "Never ask again; one switch in Settings turns it back off."},
				{ID: computer.ConsentDeny, Label: "No"},
			},
			RecommendedID: computer.ConsentAllow,
			Blocking:      true,
		})
	}
	if len(cards) > 0 {
		state.Attention = append(cards, state.Attention...)
		state.Mood = MoodNeedsYou
		state.Headline = cards[0].FromName + " wants to use this Mac"
	}
	return state
}
