package termsend

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// fake answers each command from a table keyed by its name and records
// every call, so a test can say exactly what was typed and where.
type fake struct {
	calls []string
	// ps answers `ps -o tty=,pgid=,tpgid= -p <pid>`, in order; the last
	// answer repeats.
	ps      []string
	psErr   error
	panes   string
	noTmux  bool
	running map[string]bool
	scripts map[string]string
}

func (f *fake) run(_ context.Context, name string, args ...string) ([]byte, error) {
	f.calls = append(f.calls, name+" "+strings.Join(args, " "))
	switch name {
	case "ps":
		if f.psErr != nil {
			return nil, f.psErr
		}
		out := f.ps[0]
		if len(f.ps) > 1 {
			f.ps = f.ps[1:]
		}
		return []byte(out), nil
	case "tmux":
		if f.noTmux {
			return nil, errors.New("no server running")
		}
		if args[0] == "list-panes" {
			return []byte(f.panes), nil
		}
		return nil, nil
	case "pgrep":
		if f.running[args[1]] {
			return []byte("123\n"), nil
		}
		return nil, errors.New("exit status 1")
	case "osascript":
		for process, answer := range f.scripts {
			if strings.Contains(args[1], `tell application "`+process+`"`) {
				return []byte(answer + "\n"), nil
			}
		}
		return []byte("none\n"), nil
	}
	return nil, errors.New("unexpected command " + name)
}

func (f *fake) typed() []string {
	var out []string
	for _, c := range f.calls {
		if strings.HasPrefix(c, "tmux send-keys") || strings.HasPrefix(c, "osascript") {
			out = append(out, c)
		}
	}
	return out
}

func sender(f *fake) *Sender { return &Sender{Run: f.run, AppleScript: true} }

func TestSendTypesIntoTheTmuxPaneOnTheSessionsTTY(t *testing.T) {
	f := &fake{
		ps:    []string{"ttys003 4100 4100\n"},
		panes: "/dev/ttys001\t%0\n/dev/ttys003\t%7\n",
	}
	route, err := sender(f).Send(context.Background(), 4100, "-n keep the clock freeze\nand push")
	if err != nil || route != RouteTmux {
		t.Fatalf("route %q err %v", route, err)
	}
	typed := f.typed()
	want := []string{
		"tmux send-keys -t %7 -l -- -n keep the clock freeze and push",
		"tmux send-keys -t %7 Enter",
	}
	if len(typed) != 2 || typed[0] != want[0] || typed[1] != want[1] {
		t.Fatalf("typed %q, want %q", typed, want)
	}
}

func TestSendUsesTerminalAppWhenTheTabIsThere(t *testing.T) {
	f := &fake{
		ps:      []string{"ttys004 500 500\n"},
		noTmux:  true,
		running: map[string]bool{"Terminal": true},
		scripts: map[string]string{"Terminal": "typed"},
	}
	route, err := sender(f).Send(context.Background(), 500, `say "hi"; rm -rf ~`)
	if err != nil || route != RouteTerminal {
		t.Fatalf("route %q err %v", route, err)
	}
	typed := f.typed()
	if len(typed) != 1 {
		t.Fatalf("typed %q", typed)
	}
	// The device and the text are the script's arguments, after the script
	// itself: the message is never part of the AppleScript source.
	if !strings.HasSuffix(typed[0], ` /dev/ttys004 say "hi"; rm -rf ~`) {
		t.Fatalf("arguments: %q", typed[0])
	}
	for _, app := range appleScriptApps {
		if strings.Contains(app.script, "rm -rf") {
			t.Fatal("the message reached the script source")
		}
	}
}

func TestSendFallsThroughToITermAndNeverStartsAnApp(t *testing.T) {
	// Terminal is running but the tab is not in it; iTerm2 has it.
	f := &fake{
		ps:      []string{"ttys009 77 77\n"},
		noTmux:  true,
		running: map[string]bool{"Terminal": true, "iTerm2": true},
		scripts: map[string]string{"Terminal": "none", "iTerm2": "typed"},
	}
	if route, err := sender(f).Send(context.Background(), 77, "go on"); err != nil || route != RouteITerm {
		t.Fatalf("route %q err %v", route, err)
	}

	// Neither app is running: nothing is scripted, so nothing is launched.
	quiet := &fake{ps: []string{"ttys009 77 77\n"}, noTmux: true}
	if _, err := sender(quiet).Send(context.Background(), 77, "go on"); !errors.Is(err, ErrNoRoute) {
		t.Fatalf("err %v, want ErrNoRoute", err)
	}
	if typed := quiet.typed(); len(typed) != 0 {
		t.Fatalf("scripted an app that is not running: %q", typed)
	}
}

// The reason this package is safe to have: text is never typed into a
// terminal whose foreground job is not the session.
func TestSendRefusesWhenTheSessionIsNotWhatTheTerminalReads(t *testing.T) {
	cases := map[string]struct {
		f    *fake
		want error
	}{
		"the agent exited to a shell": {
			f:    &fake{ps: []string{"ttys003 4100 4222\n"}, panes: "/dev/ttys003\t%7\n"},
			want: ErrNotForeground,
		},
		"it exits between the lookup and the typing": {
			f:    &fake{ps: []string{"ttys003 4100 4100\n", "ttys003 4100 4222\n"}, panes: "/dev/ttys003\t%7\n"},
			want: ErrNotForeground,
		},
		"its terminal changed under it": {
			f:    &fake{ps: []string{"ttys003 4100 4100\n", "ttys008 4100 4100\n"}, panes: "/dev/ttys003\t%7\n"},
			want: ErrNotForeground,
		},
		"no terminal at all": {
			f:    &fake{ps: []string{"?? 4100 0\n"}},
			want: ErrNoTerminal,
		},
		"the process is gone": {
			f:    &fake{psErr: errors.New("exit status 1")},
			want: ErrNoTerminal,
		},
		"a terminal name that is not one": {
			f:    &fake{ps: []string{"ttys003;x 4100 4100\n"}},
			want: ErrNoTerminal,
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := sender(tc.f).Send(context.Background(), 4100, "run the tests"); !errors.Is(err, tc.want) {
				t.Fatalf("err %v, want %v", err, tc.want)
			}
			if typed := tc.f.typed(); len(typed) != 0 {
				t.Fatalf("typed anyway: %q", typed)
			}
		})
	}
	if _, err := sender(&fake{}).Send(context.Background(), 1, "x"); !errors.Is(err, ErrNoTerminal) {
		t.Fatalf("pid 1: %v", err)
	}
}

func TestSendWithoutAppleScriptOnlyKnowsTmux(t *testing.T) {
	f := &fake{ps: []string{"pts/4 9 9\n"}, noTmux: true, running: map[string]bool{"Terminal": true}}
	s := &Sender{Run: f.run, AppleScript: false}
	if _, err := s.Send(context.Background(), 9, "hello"); !errors.Is(err, ErrNoRoute) {
		t.Fatalf("err %v", err)
	}
	if typed := f.typed(); len(typed) != 0 {
		t.Fatalf("typed %q", typed)
	}
}

func TestFlattenMakesOneSafeLine(t *testing.T) {
	cases := map[string]string{
		"  two\n\nlines\tand   gaps  ":         "two lines and gaps",
		"an \x1b[31mescape\x1b[0m and \a bell": "an [31mescape[0m and bell",
		"back\bspace\x00null":                  "backspacenull",
		"right\u202eto left":                   "rightto left",
		"\n\t ":                                "",
		"1":                                    "1",
	}
	for in, want := range cases {
		if got := Flatten(in); got != want {
			t.Errorf("Flatten(%q) = %q, want %q", in, got, want)
		}
	}
	long := Flatten(strings.Repeat("word ", MaxText))
	if n := len([]rune(long)); n > MaxText {
		t.Errorf("flattened to %d runes, cap is %d", n, MaxText)
	}
	if _, err := sender(&fake{}).Send(context.Background(), 4100, "\x1b\n"); !errors.Is(err, ErrEmpty) {
		t.Errorf("nothing left to type: %v", err)
	}
}
