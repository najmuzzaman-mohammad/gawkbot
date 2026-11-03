package hostcomputer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// CallTimeout bounds one tool call when the caller's context has no deadline.
var CallTimeout = 60 * time.Second

// Result is one tool call's answer: the text the driver wrote for a model,
// its structured payload when it gave one, and any images.
type Result struct {
	Text       string
	Structured json.RawMessage
	Images     []Image
	IsError    bool
}

// Image is one picture in a result.
type Image struct {
	MIMEType string
	Data     []byte
}

// Err turns an error result into a Go error.
func (r Result) Err() error {
	if !r.IsError {
		return nil
	}
	msg := strings.TrimSpace(r.Text)
	if msg == "" {
		msg = "the driver refused the call"
	}
	return errors.New(msg)
}

// Decode unmarshals the structured payload into v.
func (r Result) Decode(v any) error {
	if len(r.Structured) == 0 {
		return errors.New("the driver returned no structured content")
	}
	return json.Unmarshal(r.Structured, v)
}

// Caller is the one method the rest of the package needs from a client,
// so tests can stand a fake in.
type Caller interface {
	Call(ctx context.Context, tool string, args map[string]any) (Result, error)
}

// Client speaks MCP to the embedded daemon through the driver's own stdio
// proxy (`cua-driver mcp --embedded --socket`): the proxy never runs a tool
// itself, the host-owned daemon does, so the permission chain stays intact.
type Client struct {
	Binary string
	Socket string
	// transport, when set, replaces the proxy process; tests connect to an
	// in-memory server through it.
	transport func() mcp.Transport

	mu      sync.Mutex
	session *mcp.ClientSession
}

// NewClient returns a client for the daemon behind socket.
func NewClient(binary, socket string) *Client {
	return &Client{Binary: binary, Socket: socket}
}

// ProxyCommand is the stdio MCP proxy a bot runtime (or this client) spawns
// to reach the daemon. The embedded switch rides in env, as the daemon's.
func ProxyCommand(ctx context.Context, binary, socket string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, binary, "mcp", "--embedded", "--socket", socket)
	cmd.Env = append(cmd.Environ(), "CUA_DRIVER_EMBEDDED=1")
	return cmd
}

func (c *Client) connect(ctx context.Context) (*mcp.ClientSession, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.session != nil {
		return c.session, nil
	}
	var t mcp.Transport
	if c.transport != nil {
		t = c.transport()
	} else {
		if c.Binary == "" || c.Socket == "" {
			return nil, errors.New("host computer: driver binary and socket are required")
		}
		// The proxy outlives the connecting call: it is the session, closed
		// by Close or dropped on a transport failure.
		t = &mcp.CommandTransport{Command: ProxyCommand(context.Background(), c.Binary, c.Socket)}
	}
	client := mcp.NewClient(&mcp.Implementation{Name: "gawkbot", Version: DriverVersion}, nil)
	session, err := client.Connect(ctx, t, nil)
	if err != nil {
		return nil, fmt.Errorf("host computer: connect to the driver: %w", err)
	}
	c.session = session
	return session, nil
}

// Call runs one tool. A transport failure drops the session so the next
// call reconnects; the driver's own refusals come back as Result.IsError.
func (c *Client) Call(ctx context.Context, tool string, args map[string]any) (Result, error) {
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, CallTimeout)
		defer cancel()
	}
	session, err := c.connect(ctx)
	if err != nil {
		return Result{}, err
	}
	if args == nil {
		args = map[string]any{}
	}
	res, err := session.CallTool(ctx, &mcp.CallToolParams{Name: tool, Arguments: args})
	if err != nil {
		c.drop(session)
		return Result{}, fmt.Errorf("host computer: %s: %w", tool, err)
	}
	return resultOf(res), nil
}

func resultOf(res *mcp.CallToolResult) Result {
	out := Result{IsError: res.IsError}
	var text strings.Builder
	for _, content := range res.Content {
		switch v := content.(type) {
		case *mcp.TextContent:
			text.WriteString(v.Text)
		case *mcp.ImageContent:
			out.Images = append(out.Images, Image{MIMEType: v.MIMEType, Data: v.Data})
		}
	}
	out.Text = text.String()
	if res.StructuredContent != nil {
		if raw, err := json.Marshal(res.StructuredContent); err == nil {
			out.Structured = raw
		}
	}
	return out
}

func (c *Client) drop(session *mcp.ClientSession) {
	c.mu.Lock()
	if c.session == session {
		c.session = nil
	}
	c.mu.Unlock()
	_ = session.Close()
}

// Close ends the proxy session.
func (c *Client) Close() {
	c.mu.Lock()
	session := c.session
	c.session = nil
	c.mu.Unlock()
	if session != nil {
		_ = session.Close()
	}
}
