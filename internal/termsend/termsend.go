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
// reading it: typed at a shell, the message runs as a command. So Send
// checks, immediately before it types, that
//
//   - the process belongs to this user and IS the agent it is claimed to be
//     (a pid that turns out to be a shell, sudo or ssh is refused),
//   - its process group is the terminal's foreground job, and
//   - nothing else in that job is a program that reads the terminal itself
//     (a shell running a tool, sudo, ssh, a pager, an editor).
//
// The text is flattened to one line with control and format characters
// removed, so it cannot carry an escape sequence or submit early, and a
// message that would start one of the agent's own commands is refused: in
// Claude Code a line starting with "!" runs as a shell command with no
// permission prompt, "/" runs a slash command and "#" writes to memory.
//
// What this cannot see, the caller must: a session showing a permission
// prompt reads typed digits as its answer, and one with a half-typed prompt
// gets the message appended to it. Callers type only into a session that is
// idle, only on the owner's own action, one message at a time per session.
// The message is passed to tmux or osascript as an argument, so for that
// instant another local process of the same user can read it in `ps`.
package termsend

import (
	"context"
	"errors"
	"fmt"
	"os"
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
	// ErrNotAgent: the process is not the agent it was claimed to be, or is
	// not this user's.
	ErrNotAgent = errors.New("termsend: the process is not that agent")
	// ErrUnsafeStart: the text starts with a character the agent reads as a
	// command of its own ("!", "/" or "#").
	ErrUnsafeStart = errors.New("termsend: the message starts with a character the agent treats as a command")
	// ErrNotPermitted: macOS has not allowed this app to control the
	// terminal app (Privacy & Security, Automation).
	ErrNotPermitted = errors.New("termsend: not allowed to control the terminal app")
)

// Tools Send knows how to recognise.
const (
	ToolClaudeCode = "claude-code"
	ToolCodex      = "codex"
)

// Target is the session to type into.
type Target struct {
	// PID is the agent's process.
	PID int
	// Tool is which agent that process must be: ToolClaudeCode or ToolCodex.
	Tool string
}

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
	// UID is the user whose processes may be typed into.
	UID int
}

// New returns a Sender wired to the real machine.
func New() *Sender {
	return &Sender{
		Run: func(ctx context.Context, name string, args ...string) ([]byte, error) {
			return exec.CommandContext(ctx, name, args...).Output()
		},
		AppleScript: runtime.GOOS == "darwin",
		UID:         os.Getuid(),
	}
}

// Send types text, then Return, into the terminal the target's process is
// reading from, and reports which route carried it.
func (s *Sender) Send(ctx context.Context, target Target, text string) (string, error) {
	line := Flatten(text)
	if line == "" {
		return "", ErrEmpty
	}
	if strings.ContainsRune(commandStarts, rune(line[0])) {
		return "", ErrUnsafeStart
	}
	tty, err := s.safeTTY(ctx, target)
	if err != nil {
		return "", err
	}
	device := "/dev/" + tty

	pane, inMode := s.tmuxPane(ctx, device)
	if pane != "" {
		if inMode {
			// Copy mode and the like read keys themselves; the message
			// would steer the mode instead of reaching the agent.
			return "", ErrNotForeground
		}
		if err := s.recheck(ctx, target, tty); err != nil {
			return "", err
		}
		// One call types the line and the Return (a carriage return, which
		// -l sends as it is), so the agent cannot exit between the two and
		// leave the text sitting at a shell prompt. -l types literally, so a
		// word like "Enter" in the message is not read as a key name; "--"
		// ends the options so a message starting with a dash is still text.
		if _, err := s.run(ctx, "tmux", "send-keys", "-t", pane, "-l", "--", line+"\r"); err != nil {
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
			if err := s.recheck(ctx, target, tty); err != nil {
				return "", err
			}
			out, err := s.run(ctx, "osascript", "-e", app.script, device, line)
			if err != nil {
				if scriptDenied(err) {
					return "", ErrNotPermitted
				}
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
	// A backslash before Return is how the agent's prompt asks for another
	// line: the message would sit there unsent.
	return strings.TrimRight(b.String(), "\\ ")
}

// commandStarts are the first characters Claude Code reads as its own
// command instead of a message: shell, slash command, memory.
const commandStarts = "!/#"

func (s *Sender) run(ctx context.Context, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, stepTimeout)
	defer cancel()
	return s.Run(ctx, name, args...)
}

// safeTTY returns the short name of the target's terminal ("ttys003") once
// every check has passed: it is this user's process, it is the agent, its
// process group is what the terminal is reading, and nothing else in that
// group reads the terminal for itself.
func (s *Sender) safeTTY(ctx context.Context, target Target) (string, error) {
	pid := target.PID
	if pid <= 1 {
		return "", ErrNoTerminal
	}
	out, err := s.run(ctx, "ps", "-o", "uid=,tty=,pgid=,tpgid=,command=", "-p", strconv.Itoa(pid))
	if err != nil {
		// ps exits non-zero when the process is gone.
		return "", ErrNoTerminal
	}
	fields := strings.Fields(string(out))
	if len(fields) < 5 {
		return "", ErrNoTerminal
	}
	uid, errU := strconv.Atoi(fields[0])
	if errU != nil || uid != s.UID || !isAgent(target.Tool, fields[4:]) {
		return "", ErrNotAgent
	}
	tty := fields[1]
	if !validTTY(tty) {
		return "", ErrNoTerminal
	}
	pgid, errG := strconv.Atoi(fields[2])
	tpgid, errT := strconv.Atoi(fields[3])
	if errG != nil || errT != nil || pgid <= 0 || pgid != tpgid {
		return "", ErrNotForeground
	}

	// Who else is in the foreground job. The agent's helpers live there too
	// (its MCP servers, for one), so this is a list of what must NOT be
	// there, not of what may: programs that read the terminal themselves.
	peers, err := s.run(ctx, "ps", "-o", "pid=,pgid=,comm=", "-t", tty)
	if err != nil {
		return "", ErrNotForeground
	}
	for _, row := range strings.Split(string(peers), "\n") {
		f := strings.Fields(row)
		if len(f) < 3 {
			continue
		}
		peer, errP := strconv.Atoi(f[0])
		group, errPG := strconv.Atoi(f[1])
		if errP != nil || errPG != nil || group != tpgid || peer == pid {
			continue
		}
		if readsTerminal[base(strings.Join(f[2:], " "))] {
			return "", ErrNotForeground
		}
	}
	return tty, nil
}

// recheck repeats every check right before typing: the agent can exit, or
// start something, between finding its terminal and writing to it.
func (s *Sender) recheck(ctx context.Context, target Target, tty string) error {
	now, err := s.safeTTY(ctx, target)
	if err != nil {
		return err
	}
	if now != tty {
		return ErrNotForeground
	}
	return nil
}

// isAgent reports whether argv is the named agent: its own binary, or a
// script runtime running its package.
func isAgent(tool string, argv []string) bool {
	want := agentBinaries[tool]
	if want.name == "" || len(argv) == 0 {
		return false
	}
	exe := base(argv[0])
	if exe == want.name {
		return true
	}
	if !scriptRuntimes[exe] || len(argv) < 2 {
		return false
	}
	return base(argv[1]) == want.name || strings.Contains(argv[1], want.pkg)
}

type agentBinary struct{ name, pkg string }

var agentBinaries = map[string]agentBinary{
	ToolClaudeCode: {name: "claude", pkg: "@anthropic-ai/claude-code"},
	ToolCodex:      {name: "codex", pkg: "@openai/codex"},
}

var scriptRuntimes = map[string]bool{"node": true, "bun": true, "deno": true}

// readsTerminal are programs that take over the terminal's input when they
// run. One of them in the agent's foreground job means a message typed now
// would go to it: a password prompt, a remote shell, a pager, an editor, or
// a shell the agent started to run a command.
var readsTerminal = map[string]bool{
	"sh": true, "bash": true, "zsh": true, "fish": true, "dash": true, "ksh": true, "tcsh": true, "csh": true,
	"sudo": true, "su": true, "doas": true, "login": true, "passwd": true,
	"ssh": true, "sftp": true, "scp": true, "telnet": true, "mosh": true, "mosh-client": true,
	"less": true, "more": true, "most": true, "man": true,
	"vi": true, "vim": true, "nvim": true, "nano": true, "emacs": true, "pico": true, "ed": true,
	"gpg": true, "gpg2": true, "pinentry": true, "pinentry-curses": true, "pinentry-tty": true, "ssh-askpass": true,
	"python": true, "python3": true, "irb": true, "pry": true, "psql": true, "mysql": true, "sqlite3": true, "redis-cli": true,
	"tmux": true, "screen": true, "top": true, "htop": true, "fzf": true,
}

// base is the program name of a path or of a login shell's "-zsh".
func base(arg string) string {
	arg = strings.TrimSpace(arg)
	if i := strings.LastIndex(arg, "/"); i >= 0 {
		arg = arg[i+1:]
	}
	return strings.ToLower(strings.TrimPrefix(arg, "-"))
}

// scriptDenied reports whether osascript failed because macOS refused to
// let this app send events to the terminal app (error -1743).
func scriptDenied(err error) bool {
	var exit *exec.ExitError
	return errors.As(err, &exit) && strings.Contains(string(exit.Stderr), "-1743")
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

// tmuxPane returns the id of the tmux pane on device, or "", and whether
// that pane is in a mode (copy mode, a menu) that reads keys itself.
func (s *Sender) tmuxPane(ctx context.Context, device string) (id string, inMode bool) {
	out, err := s.run(ctx, "tmux", "list-panes", "-a", "-F", "#{pane_tty}\t#{pane_id}\t#{pane_in_mode}")
	if err != nil {
		// No tmux, or no server running.
		return "", false
	}
	for _, row := range strings.Split(string(out), "\n") {
		f := strings.Split(strings.TrimSpace(row), "\t")
		if len(f) == 3 && f[0] == device && strings.HasPrefix(f[1], "%") {
			return f[1], f[2] != "0"
		}
	}
	return "", false
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
