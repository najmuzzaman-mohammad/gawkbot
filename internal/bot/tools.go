package bot

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/nex-crm/wuphf/internal/config"
)

// ToolRegistry manages a set of named BotTools.
type ToolRegistry struct {
	tools map[string]BotTool
}

// NewToolRegistry creates an empty registry.
func NewToolRegistry() *ToolRegistry {
	return &ToolRegistry{tools: make(map[string]BotTool)}
}

// Register adds or replaces a tool in the registry.
func (r *ToolRegistry) Register(tool BotTool) {
	r.tools[tool.Name] = tool
}

// Unregister removes a tool from the registry.
func (r *ToolRegistry) Unregister(name string) {
	delete(r.tools, name)
}

// Get looks up a tool by name.
func (r *ToolRegistry) Get(name string) (BotTool, bool) {
	t, ok := r.tools[name]
	return t, ok
}

// List returns all registered tools.
func (r *ToolRegistry) List() []BotTool {
	tools := make([]BotTool, 0, len(r.tools))
	for _, t := range r.tools {
		tools = append(tools, t)
	}
	return tools
}

// Has reports whether a tool with the given name is registered.
func (r *ToolRegistry) Has(name string) bool {
	_, ok := r.tools[name]
	return ok
}

// Validate checks whether params are valid for the named tool.
// Checks: tool exists, required params present, no unknown params.
// Returns (true, nil) on success; (false, []errors) on failure.
func (r *ToolRegistry) Validate(toolName string, params map[string]any) (bool, []string) {
	tool, ok := r.tools[toolName]
	if !ok {
		return false, []string{fmt.Sprintf("unknown tool: %q", toolName)}
	}

	props := map[string]any{}
	if p, ok := tool.Schema["properties"].(map[string]any); ok {
		props = p
	}

	var errs []string

	if req, ok := tool.Schema["required"].([]any); ok {
		for _, v := range req {
			if name, ok := v.(string); ok {
				if _, present := params[name]; !present {
					errs = append(errs, fmt.Sprintf("missing required param: %q", name))
				}
			}
		}
	}

	for k := range params {
		if _, known := props[k]; !known {
			errs = append(errs, fmt.Sprintf("unknown param: %q", k))
		}
	}

	if len(errs) > 0 {
		return false, errs
	}
	return true, nil
}

// marshalResult marshals v to a JSON string.
func marshalResult(v any) (string, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return "", fmt.Errorf("marshal result: %w", err)
	}
	return string(b), nil
}

type localToolResult struct {
	Path        string   `json:"path,omitempty"`
	Pattern     string   `json:"pattern,omitempty"`
	Command     string   `json:"command,omitempty"`
	WorkingDir  string   `json:"working_directory,omitempty"`
	Append      bool     `json:"append,omitempty"`
	Bytes       int      `json:"bytes,omitempty"`
	Lines       int      `json:"lines,omitempty"`
	Files       []string `json:"files,omitempty"`
	Matches     []string `json:"matches,omitempty"`
	MatchCount  int      `json:"match_count,omitempty"`
	FileCount   int      `json:"file_count,omitempty"`
	Recipient   string   `json:"recipient,omitempty"`
	Channel     string   `json:"channel,omitempty"`
	Message     string   `json:"message,omitempty"`
	Stdout      string   `json:"stdout,omitempty"`
	Stderr      string   `json:"stderr,omitempty"`
	Combined    string   `json:"combined,omitempty"`
	ExitCode    int      `json:"exit_code"`
	Status      string   `json:"status,omitempty"`
	Timestamp   string   `json:"timestamp,omitempty"`
	Description string   `json:"description,omitempty"`
}

func localToolDefinitions() []BotTool {
	return []BotTool{
		{
			Name:        "read_file",
			Description: "Read a local file from disk.",
			Schema: map[string]any{
				"type":     "object",
				"required": []any{"path"},
				"properties": map[string]any{
					"path":              map[string]any{"type": "string"},
					"working_directory": map[string]any{"type": "string"},
				},
			},
			Execute: func(params map[string]any, ctx context.Context, onUpdate func(string)) (string, error) {
				onUpdate("Reading file...")
				path, err := resolveToolPath(params)
				if err != nil {
					return "", err
				}
				data, err := os.ReadFile(path)
				if err != nil {
					return "", err
				}
				return marshalResult(localToolResult{
					Path:       path,
					Bytes:      len(data),
					Lines:      countLines(string(data)),
					Status:     "ok",
					WorkingDir: resolvedWorkingDirectory(params),
					Combined:   string(data),
				})
			},
		},
		{
			Name:        "grep_search",
			Description: "Search local files for a regexp pattern.",
			Schema: map[string]any{
				"type":     "object",
				"required": []any{"pattern"},
				"properties": map[string]any{
					"pattern":           map[string]any{"type": "string"},
					"path":              map[string]any{"type": "string"},
					"working_directory": map[string]any{"type": "string"},
				},
			},
			Execute: func(params map[string]any, ctx context.Context, onUpdate func(string)) (string, error) {
				onUpdate("Searching files...")
				pattern, _ := params["pattern"].(string)
				if strings.TrimSpace(pattern) == "" {
					return "", fmt.Errorf("pattern is required")
				}
				re, err := regexp.Compile(pattern)
				if err != nil {
					return "", fmt.Errorf("compile pattern: %w", err)
				}
				root, err := resolveSearchRoot(params)
				if err != nil {
					return "", err
				}

				var matches []string
				fileSet := make(map[string]struct{})
				err = filepath.WalkDir(root, func(path string, d fs.DirEntry, walkErr error) error {
					if walkErr != nil {
						return walkErr
					}
					select {
					case <-ctx.Done():
						return ctx.Err()
					default:
					}
					if d.IsDir() {
						return nil
					}
					data, err := os.ReadFile(path)
					if err != nil {
						// Skip files that vanish mid-walk or have per-file
						// perms — grep is best-effort. Genuine I/O failures
						// propagate so the user sees the real problem
						// instead of a silently empty match list.
						if errors.Is(err, fs.ErrNotExist) || errors.Is(err, fs.ErrPermission) {
							return nil
						}
						return fmt.Errorf("read %s: %w", path, err)
					}
					lines := strings.Split(string(data), "\n")
					for i, line := range lines {
						if re.MatchString(line) {
							rel, relErr := filepath.Rel(root, path)
							if relErr != nil {
								rel = path
							}
							matches = append(matches, fmt.Sprintf("%s:%d:%s", rel, i+1, line))
							fileSet[path] = struct{}{}
						}
					}
					return nil
				})
				if err != nil {
					return "", err
				}

				files := make([]string, 0, len(fileSet))
				for path := range fileSet {
					rel, relErr := filepath.Rel(root, path)
					if relErr != nil {
						rel = path
					}
					files = append(files, rel)
				}

				return marshalResult(localToolResult{
					Pattern:    pattern,
					Path:       root,
					Matches:    matches,
					Files:      files,
					MatchCount: len(matches),
					FileCount:  len(files),
					Status:     "ok",
					WorkingDir: resolvedWorkingDirectory(params),
				})
			},
		},
		{
			Name:        "glob",
			Description: "Expand a filepath glob from the local filesystem.",
			Schema: map[string]any{
				"type":     "object",
				"required": []any{"pattern"},
				"properties": map[string]any{
					"pattern":           map[string]any{"type": "string"},
					"working_directory": map[string]any{"type": "string"},
				},
			},
			Execute: func(params map[string]any, ctx context.Context, onUpdate func(string)) (string, error) {
				onUpdate("Expanding glob...")
				pattern, _ := params["pattern"].(string)
				if strings.TrimSpace(pattern) == "" {
					return "", fmt.Errorf("pattern is required")
				}
				absPattern, err := resolvePath(resolvedWorkingDirectory(params), pattern)
				if err != nil {
					return "", err
				}
				files, err := filepath.Glob(absPattern)
				if err != nil {
					return "", err
				}
				base := resolvedWorkingDirectory(params)
				if base == "" {
					base, _ = os.Getwd()
				}
				relFiles := make([]string, 0, len(files))
				for _, file := range files {
					rel, relErr := filepath.Rel(base, file)
					if relErr != nil {
						rel = file
					}
					relFiles = append(relFiles, rel)
				}
				return marshalResult(localToolResult{
					Pattern:    pattern,
					WorkingDir: base,
					Files:      relFiles,
					FileCount:  len(relFiles),
					Status:     "ok",
				})
			},
		},
		{
			Name:        "write_file",
			Description: "Write or append local file content.",
			Schema: map[string]any{
				"type":     "object",
				"required": []any{"path", "content"},
				"properties": map[string]any{
					"path":              map[string]any{"type": "string"},
					"content":           map[string]any{"type": "string"},
					"append":            map[string]any{"type": "boolean"},
					"working_directory": map[string]any{"type": "string"},
				},
			},
			Execute: func(params map[string]any, ctx context.Context, onUpdate func(string)) (string, error) {
				onUpdate("Writing file...")
				path, err := resolveToolPath(params)
				if err != nil {
					return "", err
				}
				content, _ := params["content"].(string)
				appendMode, _ := params["append"].(bool)
				if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
					return "", err
				}
				flags := os.O_CREATE | os.O_WRONLY | os.O_TRUNC
				if appendMode {
					flags = os.O_CREATE | os.O_WRONLY | os.O_APPEND
				}
				f, err := os.OpenFile(path, flags, 0o644)
				if err != nil {
					return "", err
				}
				if _, err := f.WriteString(content); err != nil {
					_ = f.Close()
					return "", err
				}
				if err := f.Close(); err != nil {
					return "", err
				}
				return marshalResult(localToolResult{
					Path:       path,
					Append:     appendMode,
					Bytes:      len(content),
					Lines:      countLines(content),
					Status:     "ok",
					WorkingDir: resolvedWorkingDirectory(params),
				})
			},
		},
		{
			Name:        "bash",
			Description: "Run a local shell command and capture stdout/stderr.",
			Schema: map[string]any{
				"type":     "object",
				"required": []any{"command"},
				"properties": map[string]any{
					"command":           map[string]any{"type": "string"},
					"working_directory": map[string]any{"type": "string"},
				},
			},
			Execute: func(params map[string]any, ctx context.Context, onUpdate func(string)) (string, error) {
				onUpdate("Running bash...")
				command, _ := params["command"].(string)
				if strings.TrimSpace(command) == "" {
					return "", fmt.Errorf("command is required")
				}
				wd := resolvedWorkingDirectory(params)
				if wd == "" {
					wd, _ = os.Getwd()
				}
				cmd := newShellCommand(ctx, command)
				cmd.Dir = wd
				var stdout bytes.Buffer
				var stderr bytes.Buffer
				cmd.Stdout = &stdout
				cmd.Stderr = &stderr
				err := cmd.Run()
				exitCode := 0
				if err != nil {
					var exitErr *exec.ExitError
					if errors.As(err, &exitErr) {
						exitCode = exitErr.ExitCode()
					} else {
						return "", err
					}
				}
				if exitCode == 0 && cmd.ProcessState != nil {
					exitCode = cmd.ProcessState.ExitCode()
				}
				result := localToolResult{
					Command:     command,
					WorkingDir:  wd,
					Stdout:      stdout.String(),
					Stderr:      stderr.String(),
					Combined:    stdout.String() + stderr.String(),
					ExitCode:    exitCode,
					Lines:       countLines(stdout.String() + stderr.String()),
					Status:      "ok",
					Description: "Shell command completed",
				}
				return marshalResult(result)
			},
		},
		{
			Name:        "send_message",
			Description: "Queue a lightweight bot-to-bot message on disk.",
			Schema: map[string]any{
				"type":     "object",
				"required": []any{"recipient", "message"},
				"properties": map[string]any{
					"recipient": map[string]any{"type": "string"},
					"message":   map[string]any{"type": "string"},
					"channel":   map[string]any{"type": "string"},
				},
			},
			Execute: func(params map[string]any, ctx context.Context, onUpdate func(string)) (string, error) {
				onUpdate("Sending message...")
				recipient, _ := params["recipient"].(string)
				message, _ := params["message"].(string)
				channel, _ := params["channel"].(string)
				if strings.TrimSpace(recipient) == "" {
					return "", fmt.Errorf("recipient is required")
				}
				if strings.TrimSpace(message) == "" {
					return "", fmt.Errorf("message is required")
				}
				home := config.RuntimeHomeDir()
				if home == "" {
					return "", fmt.Errorf("cannot resolve runtime home directory")
				}
				outboxDir := filepath.Join(home, ".wuphf", "office", "messages")
				if err := os.MkdirAll(outboxDir, 0o755); err != nil {
					return "", err
				}
				entry := localToolResult{
					Recipient: strings.TrimSpace(recipient),
					Channel:   strings.TrimSpace(channel),
					Message:   message,
					Status:    "queued",
					Timestamp: time.Now().UTC().Format(time.RFC3339),
				}
				payload, err := json.Marshal(entry)
				if err != nil {
					return "", err
				}
				f, err := os.OpenFile(filepath.Join(outboxDir, "outbox.jsonl"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
				if err != nil {
					return "", err
				}
				if _, err := f.Write(append(payload, '\n')); err != nil {
					_ = f.Close()
					return "", err
				}
				if err := f.Close(); err != nil {
					return "", err
				}
				return string(payload), nil
			},
		},
	}
}

func resolvedWorkingDirectory(params map[string]any) string {
	wd, _ := params["working_directory"].(string)
	return strings.TrimSpace(wd)
}

func resolveToolPath(params map[string]any) (string, error) {
	path, _ := params["path"].(string)
	if strings.TrimSpace(path) == "" {
		return "", fmt.Errorf("path is required")
	}
	return resolvePath(resolvedWorkingDirectory(params), path)
}

func resolveSearchRoot(params map[string]any) (string, error) {
	if path, ok := params["path"].(string); ok && strings.TrimSpace(path) != "" {
		return resolvePath(resolvedWorkingDirectory(params), path)
	}
	wd := resolvedWorkingDirectory(params)
	if wd == "" {
		var err error
		wd, err = os.Getwd()
		if err != nil {
			return "", err
		}
	}
	return filepath.Abs(wd)
}

func resolvePath(base, target string) (string, error) {
	if strings.TrimSpace(target) == "" {
		return "", fmt.Errorf("path is required")
	}
	if filepath.IsAbs(target) {
		return filepath.Clean(target), nil
	}
	if strings.TrimSpace(base) == "" {
		var err error
		base, err = os.Getwd()
		if err != nil {
			return "", err
		}
	}
	return filepath.Abs(filepath.Join(base, target))
}

func countLines(text string) int {
	if text == "" {
		return 0
	}
	return strings.Count(text, "\n") + 1
}

// CreateBuiltinTools returns the tools every bot gets by default. These all
// run locally against the office's own state; there is no remote knowledge-base
// service behind any of them.
func CreateBuiltinTools() []BotTool {
	tools := []BotTool{}
	tools = append(tools, localToolDefinitions()...)
	return tools
}
