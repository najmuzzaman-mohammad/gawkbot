package commands

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/nex-crm/wuphf/internal/bot"
	"github.com/nex-crm/wuphf/internal/config"
)

// CommandResult holds the output from a non-interactive command dispatch.
type CommandResult struct {
	Output   string
	Data     any
	ExitCode int
	Error    string
}

// DispatchWithService is like Dispatch but accepts a BotService for commands
// that need access to running bots (e.g. /bots, /bot).
func DispatchWithService(input string, format string, timeout int, botSvc *bot.BotService) CommandResult {
	return dispatchInternal(input, format, timeout, botSvc)
}

// Dispatch parses input and runs the matching command non-interactively.
// format is "text" or "json"; timeout is in milliseconds (0 = default).
func Dispatch(input string, format string, timeout int) CommandResult {
	return dispatchInternal(input, format, timeout, nil)
}

func dispatchInternal(input string, format string, timeout int, botSvc *bot.BotService) CommandResult {
	name, args, isSlash := ParseSlashInput(input)
	if !isSlash {
		// Plain prose has no non-interactive handler: conversation belongs to
		// the running office, not to a one-shot CLI invocation. Say so rather
		// than routing it somewhere that will not answer.
		return CommandResult{
			Output:   "Plain text is not a command. Launch the office and talk to the team there, or pass a slash command (see /help).",
			ExitCode: 1,
			Error:    "not a command",
		}
	}

	r := NewRegistry()
	RegisterAllCommands(r)

	cmd, ok := r.Get(name)
	if !ok {
		return CommandResult{
			Output:   fmt.Sprintf("Unknown command: /%s", name),
			ExitCode: 1,
			Error:    fmt.Sprintf("unknown command: %s", name),
		}
	}

	if cmd.Execute == nil {
		return CommandResult{
			Output: fmt.Sprintf("/%s — %s (not available in non-interactive mode)", cmd.Name, cmd.Description),
		}
	}

	cfg, _ := config.Load()

	var output strings.Builder
	var execErr error

	ctx := &SlashContext{
		BotService: botSvc,
		Config:     &cfg,
		AddMessage: func(role, content string) {
			output.WriteString(content)
			output.WriteString("\n")
		},
		SetLoading:  func(bool) {},
		ShowPicker:  nil,
		ShowConfirm: nil,
		SendResult: func(out string, err error) {
			if out != "" {
				output.WriteString(out)
				output.WriteString("\n")
			}
			if err != nil {
				execErr = err
			}
		},
	}

	err := cmd.Execute(ctx, args)
	if err != nil {
		if errors.Is(err, ErrQuit) {
			return CommandResult{Output: "", ExitCode: 0}
		}
		return CommandResult{
			Output:   output.String(),
			ExitCode: 1,
			Error:    err.Error(),
		}
	}
	if execErr != nil {
		return CommandResult{
			Output:   output.String(),
			ExitCode: 1,
			Error:    execErr.Error(),
		}
	}

	outStr := strings.TrimRight(output.String(), "\n")
	if format == "json" {
		payload := map[string]any{"output": outStr}
		b, _ := json.Marshal(payload)
		return CommandResult{Output: string(b), Data: payload}
	}
	return CommandResult{Output: outStr}
}
