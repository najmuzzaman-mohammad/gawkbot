package computer

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/nex-crm/wuphf/internal/runtimebin"
)

// The MCP bridge is the process a bot CLI spawns as its "computer"
// server. It pipes stdio into `docker exec -i … cua-driver mcp` inside the
// bot's container and defines almost nothing itself: bytes in, bytes out.
//
// Two exceptions, both on the near side because Cua Driver has no notion of
// a person holding the wheel:
//
//  1. The who-is-driving gate. While the person holds control in the app, a
//     tools/call from the bot is answered with a refusal here and never
//     forwarded.
//  2. One extra tool, computer_request_help, which lets the bot ask for
//     hands (a login, a CAPTCHA, a judgment call) and wait until the person
//     hands control back.
//
// Frames are handled one line at a time in order: MCP's stdio transport is
// one JSON-RPC frame per line, so line boundaries are the only safe place
// to inspect or inject anything.

// ControlRefusal is what the model reads when its hands are refused.
const ControlRefusal = "The person is driving this computer right now. Your clicks and keystrokes are refused, not queued. Wait, then take a fresh screenshot before acting again."

// HelpToolName is the tool the bridge adds to the driver's list.
const HelpToolName = "computer_request_help"

// HelpWaitTimeout bounds how long a help request waits for the person.
var HelpWaitTimeout = 10 * time.Minute

// helpPollInterval is how often the waiting bot re-reads control state.
var helpPollInterval = 2 * time.Second

// GateClient is the bridge-side half of computer control. Failure posture
// is OPEN: control is cooperation between a person and their own bot, not
// a security boundary, and a broker hiccup must not brick every computer
// mid-turn.
type GateClient struct {
	URL     string
	Token   string
	Client  *http.Client
	CacheMs int

	mu       sync.Mutex
	cachedAt time.Time
	cached   Snapshot
}

// Configured reports whether the gate has an endpoint to ask.
func (g *GateClient) Configured() bool { return g != nil && g.URL != "" && g.Token != "" }

func (g *GateClient) client() *http.Client {
	if g.Client != nil {
		return g.Client
	}
	return &http.Client{Timeout: 2 * time.Second}
}

// State returns the current snapshot, cached briefly so a batch of two
// dozen actions is not two dozen loopback round trips. fresh bypasses it.
func (g *GateClient) State(ctx context.Context, fresh bool) Snapshot {
	if !g.Configured() {
		return Snapshot{}
	}
	cacheFor := time.Duration(g.CacheMs) * time.Millisecond
	if cacheFor <= 0 {
		cacheFor = 750 * time.Millisecond
	}
	g.mu.Lock()
	if !fresh && time.Since(g.cachedAt) < cacheFor {
		s := g.cached
		g.mu.Unlock()
		return s
	}
	g.mu.Unlock()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, g.URL, nil)
	if err != nil {
		return Snapshot{}
	}
	req.Header.Set("Authorization", "Bearer "+g.Token)
	res, err := g.client().Do(req)
	if err != nil {
		return Snapshot{}
	}
	defer res.Body.Close()
	var s Snapshot
	if res.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&s) != nil {
		return Snapshot{}
	}
	g.mu.Lock()
	g.cached, g.cachedAt = s, time.Now()
	g.mu.Unlock()
	return s
}

func (g *GateClient) post(ctx context.Context, body any) (map[string]any, error) {
	payload, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.URL, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+g.Token)
	req.Header.Set("Content-Type", "application/json")
	res, err := g.client().Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	var out map[string]any
	if err := json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&out); err != nil {
		return nil, err
	}
	if res.StatusCode != http.StatusOK {
		return out, fmt.Errorf("control endpoint answered %d", res.StatusCode)
	}
	return out, nil
}

// RequestHelp surfaces the bot's plea and returns its id.
func (g *GateClient) RequestHelp(ctx context.Context, reason string) (string, error) {
	out, err := g.post(ctx, map[string]any{"action": "request-help", "reason": reason})
	if err != nil {
		return "", err
	}
	id, _ := out["request_id"].(string)
	return id, nil
}

// ExpireHelp closes only the plea this bridge opened.
func (g *GateClient) ExpireHelp(ctx context.Context, id string) {
	_, _ = g.post(ctx, map[string]any{"action": "expire-help", "request_id": id})
}

// BridgeConfig wires one bridge run.
type BridgeConfig struct {
	Command string
	Args    []string
	Gate    *GateClient
	Stdin   io.Reader
	Stdout  io.Writer
	Stderr  io.Writer
}

// RunBridge spawns the far end and pumps frames until the bot closes
// stdin or the child exits. It returns the child's exit error, if any.
func RunBridge(ctx context.Context, cfg BridgeConfig) error {
	path, err := runtimebin.LookPath(cfg.Command)
	if err != nil {
		return fmt.Errorf("could not find %s: %w", cfg.Command, err)
	}
	child := exec.CommandContext(ctx, path, cfg.Args...)
	child.Stderr = cfg.Stderr
	childIn, err := child.StdinPipe()
	if err != nil {
		return err
	}
	childOut, err := child.StdoutPipe()
	if err != nil {
		return err
	}
	if err := child.Start(); err != nil {
		return fmt.Errorf("could not connect to Cua Driver: %w", err)
	}
	var outMu sync.Mutex
	emit := func(line string) {
		outMu.Lock()
		defer outMu.Unlock()
		_, _ = io.WriteString(cfg.Stdout, line+"\n")
	}
	interceptor := &gateInterceptor{gate: cfg.Gate, forward: func(line string) {
		_, _ = io.WriteString(childIn, line+"\n")
	}, emit: emit, listIDs: map[string]bool{}}

	// Child stdout → bot, at line granularity, so an injected refusal
	// never lands inside a half-written frame.
	outDone := make(chan struct{})
	go func() {
		defer close(outDone)
		reader := bufio.NewReaderSize(childOut, 1<<20)
		for {
			line, err := reader.ReadString('\n')
			if line != "" {
				interceptor.fromChild(strings.TrimRight(line, "\r\n"))
			}
			if err != nil {
				return
			}
		}
	}()
	// Bot stdin → child, through the gate.
	inDone := make(chan struct{})
	go func() {
		defer close(inDone)
		defer childIn.Close()
		reader := bufio.NewReaderSize(cfg.Stdin, 1<<20)
		for {
			line, err := reader.ReadString('\n')
			if line != "" {
				interceptor.fromBot(ctx, strings.TrimRight(line, "\r\n"))
			}
			if err != nil {
				return
			}
		}
	}()
	waitErr := child.Wait()
	<-outDone
	return waitErr
}

type rpcFrame struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
}

type gateInterceptor struct {
	gate    *GateClient
	forward func(line string)
	emit    func(line string)

	mu      sync.Mutex
	listIDs map[string]bool
}

func (g *gateInterceptor) fromBot(ctx context.Context, line string) {
	var frame rpcFrame
	if err := json.Unmarshal([]byte(line), &frame); err != nil || frame.Method == "" {
		g.forward(line)
		return
	}
	switch frame.Method {
	case "tools/list":
		if len(frame.ID) > 0 {
			g.mu.Lock()
			g.listIDs[string(frame.ID)] = true
			g.mu.Unlock()
		}
		g.forward(line)
	case "tools/call":
		var params struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		}
		_ = json.Unmarshal(frame.Params, &params)
		if params.Name == HelpToolName {
			g.emit(rpcResult(frame.ID, g.handleHelp(ctx, params.Arguments), false))
			return
		}
		if g.gate.Configured() && g.gate.State(ctx, true).Held {
			g.emit(rpcResult(frame.ID, ControlRefusal, true))
			return
		}
		g.forward(line)
	default:
		g.forward(line)
	}
}

func (g *gateInterceptor) fromChild(line string) {
	var frame rpcFrame
	if err := json.Unmarshal([]byte(line), &frame); err != nil || len(frame.ID) == 0 || len(frame.Result) == 0 {
		g.emit(line)
		return
	}
	g.mu.Lock()
	isList := g.listIDs[string(frame.ID)]
	if isList {
		delete(g.listIDs, string(frame.ID))
	}
	g.mu.Unlock()
	if !isList {
		g.emit(line)
		return
	}
	var result map[string]json.RawMessage
	if err := json.Unmarshal(frame.Result, &result); err != nil {
		g.emit(line)
		return
	}
	var tools []json.RawMessage
	_ = json.Unmarshal(result["tools"], &tools)
	tools = append(tools, json.RawMessage(helpToolDefinition()))
	toolsJSON, _ := json.Marshal(tools)
	result["tools"] = toolsJSON
	resultJSON, _ := json.Marshal(result)
	out, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": frame.ID, "result": json.RawMessage(resultJSON)})
	g.emit(string(out))
}

func (g *gateInterceptor) handleHelp(ctx context.Context, args map[string]any) string {
	reason, _ := args["reason"].(string)
	reason = strings.TrimSpace(reason)
	if reason == "" {
		reason = "The bot needs your hands on its computer."
	}
	if !g.gate.Configured() {
		return "Help requests are not available for this computer. Explain what you need in your reply instead."
	}
	id, err := g.gate.RequestHelp(ctx, reason)
	if err != nil {
		return "Could not reach the app to ask for help: " + err.Error() + ". Explain what you need in your reply instead."
	}
	deadline := time.Now().Add(HelpWaitTimeout)
	sawHold := false
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			g.gate.ExpireHelp(context.Background(), id)
			return "The turn ended before anyone answered."
		case <-time.After(helpPollInterval):
		}
		s := g.gate.State(ctx, true)
		if s.Held {
			sawHold = true
			continue
		}
		if sawHold {
			return "The person handled it and handed control back. Take a fresh screenshot and continue."
		}
		if !s.HelpOpen {
			return "The person dismissed the request without taking control. Continue on your own or explain in your reply."
		}
	}
	g.gate.ExpireHelp(context.Background(), id)
	return "Nobody answered within " + HelpWaitTimeout.String() + ". Explain what you need in your reply and stop."
}

func rpcResult(id json.RawMessage, text string, isError bool) string {
	if len(id) == 0 {
		id = json.RawMessage("null")
	}
	out, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"result": map[string]any{
			"content": []map[string]any{{"type": "text", "text": text}},
			"isError": isError,
		},
	})
	return string(out)
}

func helpToolDefinition() string {
	def := map[string]any{
		"name":        HelpToolName,
		"description": "Ask the person watching this computer to take control for a moment, for example to log in, solve a CAPTCHA, or make a judgment call. Blocks until they hand control back, dismiss the request, or ten minutes pass. Take a fresh screenshot afterwards.",
		"inputSchema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"reason": map[string]any{"type": "string", "description": "One sentence: what you need them to do and where."},
			},
			"required": []string{"reason"},
		},
	}
	out, _ := json.Marshal(def)
	return string(out)
}
