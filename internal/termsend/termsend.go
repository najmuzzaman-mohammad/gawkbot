// Package termsend types a message into the terminal an agent session is
// running in, so a session the human opened themselves can be answered from
// gawkbot while its window is still open.
//
// A Claude Code window owns its session: nothing outside it can hand it a
// prompt, and a second process resuming the same session only writes a second
// copy of its history. What does reach it is its own terminal. This package
// finds that terminal from the session's process and types there, through
// whichever of these is hosting it:
//
//   - tmux: send-keys to the pane whose tty is the session's
//   - Terminal.app: AppleScript "do script" in the tab whose tty is the session's
//   - iTerm2: AppleScript "write text" to the session whose tty is the session's
//
// Typing into someone's terminal is only safe when the agent is the program
// reading it. So Send checks, immediately before it types, that the session's
// process is the terminal's foreground job. If the agent has exited and a
// shell is waiting there, the message would run as a command; Send refuses.
// The text is flattened to one line with control characters removed, so it
// cannot carry an escape sequence or submit early.
//
// The caller decides WHEN: a session showing a permission prompt reads typed
// digits as its answer, so callers type only into a session that is idle.
package termsend

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"
	"unicode"
)

var (
	// ErrNoTerminal: the process has no terminal (a background or SDK run).
	ErrNoTerminal = errors.New("termsend: the session has no terminal")
	// ErrNotForeground: something else is reading the terminal right now
	// (the agent exited to a shell, or started a program of its own).
	ErrNotForeground = errors.New("termsend: the session is not what its terminal is reading")
	// ErrNoRoute: the terminal is hosted by an app this package cannot type
	// into (anything but tmux, Terminal.app and iTerm2).
	ErrNoRoute = errors.New("termsend: no way to type into this terminal app")
	// ErrEmpty: nothing is left of the text once it is made safe to type.
	ErrEmpty = errors.New("termsend: nothing to type")
)

// Routes, as returned by Send.
const (
	RouteTmux     = "tmux"
	RouteTerminal = "terminal"
	RouteITerm    = "iterm"
)

const (
	// MaxText is the most runes typed in one message.
	MaxText     = 4000
	stepTimeout = 6 * time.Second
)

// RunFunc runs a command and returns its standard output.
type RunFunc func(ctx context.Context, name string, args ...string) ([]byte, error)

// Sender types into terminals. The zero value is not usable; call New.
type Sender struct {
	// Run executes ps, tmux, pgrep and osascript. Tests replace it.
	Run RunFunc
	// AppleScript says whether the Terminal.app and iTerm2 routes exist
	// (macOS only).
	AppleScript bool
}

// New returns a Sender wired to the real machine.
func New() *Sender {
	return &Sender{
		Run: func(ctx context.Context, name string, args ...string) ([]byte, error) {
			return exec.CommandContext(ctx, name, args...).Output()
		},
		AppleScript: runtime.GOOS == "darwin",
	}
}

// Send types text, then Return, into the terminal that process pid is
// reading from, and reports which route carried it.
func (s *Sender) Send(ctx context.Context, pid int, text string) (string, error) {
	line := Flatten(text)
	if line == "" {
		return "", ErrEmpty
	}
	tty, err := s.foregroundTTY(ctx, pid)
	if err != nil {
		return "", err
	}
	device := "/dev/" + tty

	if pane := s.tmuxPane(ctx, device); pane != "" {
		if err := s.recheck(ctx, pid, tty); err != nil {
			return "", err
		}
		// -l types the text literally, so a word like "Enter" in the message
		// is not read as a key name; "--" ends the options so a message that
		// starts with a dash is still text.
		if _, err := s.run(ctx, "tmux", "send-keys", "-t", pane, "-l", "--", line); err != nil {
			return "", fmt.Errorf("termsend: tmux: %w", err)
		}
		if _, err := s.run(ctx, "tmux", "send-keys", "-t", pane, "Enter"); err != nil {
			return "", fmt.Errorf("termsend: tmux: %w", err)
		}
		return RouteTmux, nil
	}

	if s.AppleScript {
		for _, app := range appleScriptApps {
			if !s.appRunning(ctx, app.process) {
				// Never start a terminal app just to look for a tab in it.
				continue
			}
			if err := s.recheck(ctx, pid, tty); err != nil {
				return "", err
			}
			out, err := s.run(ctx, "osascript", "-e", app.script, device, line)
			if err != nil {
				return "", fmt.Errorf("termsend: %s: %w", app.route, err)
			}
			if strings.TrimSpace(string(out)) == scriptTyped {
				return app.route, nil
			}
		}
	}
	return "", ErrNoRoute
}

// Flatten makes text safe to type as one line: every run of whitespace
// (newlines included) becomes one space, control and format characters are
// dropped, and the result is cut to MaxText runes.
func Flatten(text string) string {
	var b strings.Builder
	space := false
	count := 0
	for _, r := range text {
		switch {
		case unicode.IsSpace(r):
			space = b.Len() > 0
			continue
		case unicode.IsControl(r), unicode.Is(unicode.Cf, r):
			// Escape, bell, backspace and the invisible format characters
			// (bidi overrides among them) have no business in a typed line.
			continue
		}
		need := 1
		if space {
			need = 2
		}
		if count+need > MaxText {
			break
		}
		if space {
			b.WriteByte(' ')
			space = false
		}
		b.WriteRune(r)
		count += need
	}
	return b.String()
}

func (s *Sender) run(ctx context.Context, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, stepTimeout)
	defer cancel()
	return s.Run(ctx, name, args...)
}

// foregroundTTY returns the short name of pid's terminal ("ttys003") once it
// has confirmed that pid's process group is the one the terminal is reading.
func (s *Sender) foregroundTTY(ctx context.Context, pid int) (string, error) {
	if pid <= 1 {
		return "", ErrNoTerminal
	}
	out, err := s.run(ctx, "ps", "-o", "tty=,pgid=,tpgid=", "-p", strconv.Itoa(pid))
	if err != nil {
		// ps exits non-zero when the process is gone.
		return "", ErrNoTerminal
	}
	fields := strings.Fields(string(out))
	if len(fields) != 3 {
		return "", ErrNoTerminal
	}
	tty := fields[0]
	if !validTTY(tty) {
		return "", ErrNoTerminal
	}
	pgid, errG := strconv.Atoi(fields[1])
	tpgid, errT := strconv.Atoi(fields[2])
	if errG != nil || errT != nil || pgid <= 0 || pgid != tpgid {
		return "", ErrNotForeground
	}
	return tty, nil
}

// recheck repeats the foreground test right before typing: the agent can
// exit between finding its terminal and writing to it.
func (s *Sender) recheck(ctx context.Context, pid int, tty string) error {
	now, err := s.foregroundTTY(ctx, pid)
	if err != nil {
		return err
	}
	if now != tty {
		return ErrNotForeground
	}
	return nil
}

// validTTY accepts the names ps prints for a real terminal ("ttys003",
// "pts/4") and nothing that could be read as anything else: the name goes
// into a device path that is compared, and passed to osascript as an
// argument.
func validTTY(tty string) bool {
	if tty == "" || tty == "?" || tty == "??" || tty == "-" || len(tty) > 32 {
		return false
	}
	for _, r := range tty {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '/') {
			return false
		}
	}
	return !strings.Contains(tty, "//") && !strings.HasPrefix(tty, "/") && !strings.HasSuffix(tty, "/")
}

// tmuxPane returns the id of the tmux pane on device, or "".
func (s *Sender) tmuxPane(ctx context.Context, device string) string {
	out, err := s.run(ctx, "tmux", "list-panes", "-a", "-F", "#{pane_tty}\t#{pane_id}")
	if err != nil {
		// No tmux, or no server running.
		return ""
	}
	for _, row := range strings.Split(string(out), "\n") {
		tty, id, ok := strings.Cut(strings.TrimSpace(row), "\t")
		if ok && tty == device && strings.HasPrefix(id, "%") {
			return id
		}
	}
	return ""
}

func (s *Sender) appRunning(ctx context.Context, process string) bool {
	out, err := s.run(ctx, "pgrep", "-x", process)
	return err == nil && strings.TrimSpace(string(out)) != ""
}

// scriptTyped is what a script prints when it found the tab and typed.
const scriptTyped = "typed"

type appleScriptApp struct {
	route   string
	process string
	script  string
}

// The device and the text arrive as arguments (item 1 and item 2 of argv),
// never spliced into the script, so nothing in a message can become
// AppleScript.
var appleScriptApps = []appleScriptApp{
	{
		route:   RouteTerminal,
		process: "Terminal",
		script: `on run argv
	set theDevice to item 1 of argv
	set theText to item 2 of argv
	tell application "Terminal"
		repeat with w in windows
			repeat with t in tabs of w
				if tty of t is theDevice then
					do script theText in t
					return "typed"
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
	set theText to item 2 of argv
	tell application "iTerm2"
		repeat with w in windows
			repeat with t in tabs of w
				repeat with s in sessions of t
					if tty of s is theDevice then
						tell s to write text theText
						return "typed"
					end if
				end repeat
			end repeat
		end repeat
	end tell
	return "none"
end run`,
	},
}
