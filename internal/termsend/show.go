package termsend

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

// Show brings the terminal a session runs in to the front, at the session's
// own tab, pane, or Superset terminal, so the person can read it there in
// full. It types nothing. The process must be this user's and the agent,
// as for Send; unlike Send it does not matter what the terminal is doing.
func (s *Sender) Show(ctx context.Context, target Target) (string, error) {
	if target.PID <= 1 {
		return "", ErrNoTerminal
	}
	out, err := s.run(ctx, "ps", "-o", "uid=,tty=,command=", "-p", strconv.Itoa(target.PID))
	if err != nil {
		return "", ErrNoTerminal
	}
	fields := strings.Fields(string(out))
	if len(fields) < 3 {
		return "", ErrNoTerminal
	}
	uid, errU := strconv.Atoi(fields[0])
	if errU != nil || uid != s.UID || !isAgent(target.Tool, fields[2:]) {
		return "", ErrNotAgent
	}
	tty := fields[1]
	if !validTTY(tty) {
		return "", ErrNoTerminal
	}
	device := "/dev/" + tty

	if workspace, terminal := s.supersetIDs(ctx, target.PID); workspace != "" && terminal != "" {
		q := url.Values{"terminalId": {terminal}, "focusRequestId": {focusID()}}
		link := "superset://v2-workspace/" + workspace + "?" + q.Encode()
		if _, err := s.run(ctx, "open", link); err != nil {
			return "", fmt.Errorf("termsend: superset: %w", err)
		}
		return RouteSuperset, nil
	}
	if pane, _ := s.tmuxPane(ctx, device); pane != "" {
		_, errW := s.run(ctx, "tmux", "select-window", "-t", pane)
		_, errP := s.run(ctx, "tmux", "select-pane", "-t", pane)
		if errW != nil || errP != nil {
			return "", fmt.Errorf("termsend: tmux: could not select pane %s", pane)
		}
		return RouteTmux, nil
	}
	if s.AppleScript {
		for _, app := range showScripts {
			if !s.appRunning(ctx, app.process) {
				continue
			}
			out, err := s.run(ctx, "osascript", "-e", app.script, device)
			if err != nil {
				if scriptDenied(err) {
					return "", ErrNotPermitted
				}
				return "", fmt.Errorf("termsend: %s: %w", app.route, err)
			}
			if strings.TrimSpace(string(out)) == scriptShown {
				return app.route, nil
			}
		}
	}
	return "", ErrNoRoute
}

// ResumeInTerminal opens a new Terminal.app window in cwd running the
// agent's resume of the session with this id, for a session whose window is
// gone. id must be a bare uuid; cwd and id reach the shell quoted by
// AppleScript, never spliced into the script.
func (s *Sender) ResumeInTerminal(ctx context.Context, tool, id, cwd string) error {
	if !s.AppleScript {
		return ErrNoRoute
	}
	if !bareUUID(id) || !strings.HasPrefix(cwd, "/") || strings.ContainsAny(cwd, "\x00\n\r") {
		return ErrNoTerminal
	}
	var argv []string
	switch tool {
	case ToolClaudeCode:
		argv = []string{"claude", "--resume", id}
	case ToolCodex:
		argv = []string{"codex", "resume", id}
	default:
		return ErrNotAgent
	}
	_, err := s.run(ctx, "osascript", append([]string{"-e", resumeScript, cwd}, argv...)...)
	if err != nil && scriptDenied(err) {
		return ErrNotPermitted
	}
	return err
}

func bareUUID(id string) bool {
	if len(id) != 36 {
		return false
	}
	for i, r := range id {
		switch i {
		case 8, 13, 18, 23:
			if r != '-' {
				return false
			}
		default:
			if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') {
				return false
			}
		}
	}
	return true
}

func focusID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// scriptShown is what a show script prints when it found the tab.
const scriptShown = "shown"

var showScripts = []appleScriptApp{
	{
		route:   RouteTerminal,
		process: "Terminal",
		script: `on run argv
	set theDevice to item 1 of argv
	tell application "Terminal"
		repeat with w in windows
			repeat with t in tabs of w
				if tty of t is theDevice then
					set selected of t to true
					set index of w to 1
					activate
					return "shown"
				end if
			end repeat
		end repeat
	end tell
	return "none"
end run`,
	},
	{
		route:   RouteITerm,
		process: "iTerm2",
		script: `on run argv
	set theDevice to item 1 of argv
	tell application "iTerm2"
		repeat with w in windows
			repeat with t in tabs of w
				repeat with s in sessions of t
					if tty of s is theDevice then
						select w
						tell t to select
						tell s to select
						activate
						return "shown"
					end if
				end repeat
			end repeat
		end repeat
	end tell
	return "none"
end run`,
	},
}

// resumeScript: item 1 is the folder, the rest the command's words. Each
// is quoted for the shell by AppleScript itself.
const resumeScript = `on run argv
	set theCommand to "cd " & quoted form of (item 1 of argv)
	set theWords to ""
	repeat with i from 2 to count of argv
		set theWords to theWords & " " & quoted form of (item i of argv)
	end repeat
	set theCommand to theCommand & " &&" & theWords
	tell application "Terminal"
		do script theCommand
		activate
	end tell
	return "shown"
end run`
