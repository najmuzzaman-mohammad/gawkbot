package box

import (
	"context"
	"encoding/base64"
	"fmt"
	"strings"
	"time"
)

// ProvisionResult is what the panel learns after a provision.
type ProvisionResult struct {
	BoxID       string `json:"box_id"`
	MachineName string `json:"machine_name"`
	Reused      bool   `json:"reused"`
	State       string `json:"state"`
	JoinURL     string `json:"join_url"`
}

// Provision finds or creates the bot's persistent box, waits for ready,
// runs the idempotent bootstrap, and mints a fresh desktop URL.
func (c *Client) Provision(ctx context.Context, slug, botName string) (*ProvisionResult, error) {
	if !c.Configured() {
		return nil, fmt.Errorf("cloud computers need an ascii.dev Box API key in Settings")
	}
	name := NameFor(slug)
	b, err := c.Find(ctx, slug)
	if err != nil {
		return nil, err
	}
	created := false
	if b == nil {
		b, err = c.Create(ctx)
		if err != nil {
			return nil, err
		}
		created = true
		c.Remember(slug, b.ID)
		if err := c.Rename(ctx, b.ID, name); err != nil {
			c.rollback(ctx, slug, b.ID)
			return nil, err
		}
	}
	ready, err := c.WaitReady(ctx, b.ID, 90*time.Second)
	if err != nil {
		if created {
			c.rollback(ctx, slug, b.ID)
		}
		return nil, fmt.Errorf("box did not become ready: %w", err)
	}
	var boot CommandResult
	for attempt := 0; attempt < 5; attempt++ {
		boot, err = c.Run(ctx, b.ID, BootstrapCommand(botName), 120*time.Second)
		if err == nil && (boot.OK || boot.ExitCode != nil) {
			break
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(3 * time.Second):
		}
	}
	if !boot.OK {
		detail := strings.TrimSpace(boot.Stderr)
		if detail == "" && boot.ExitCode != nil {
			detail = fmt.Sprintf("exit %d", *boot.ExitCode)
		}
		if created {
			c.rollback(ctx, slug, b.ID)
		}
		return nil, fmt.Errorf("box setup failed: %s", firstNonEmpty(detail, "no response"))
	}
	joinURL, err := c.DesktopURL(ctx, b.ID, 60*time.Second)
	if err != nil {
		return nil, err
	}
	return &ProvisionResult{BoxID: b.ID, MachineName: name, Reused: !created, State: ready.State, JoinURL: joinURL}, nil
}

func (c *Client) rollback(ctx context.Context, slug, boxID string) {
	_ = c.Delete(ctx, boxID)
	c.Forget(slug)
}

// Join wakes the box, reattaches the driver daemon, and returns a fresh
// desktop URL.
func (c *Client) Join(ctx context.Context, slug string) (string, string, error) {
	b, err := c.Find(ctx, slug)
	if err != nil {
		return "", "", err
	}
	if b == nil {
		return "", "", fmt.Errorf("no computer yet — provision it first")
	}
	ready, err := c.WaitReady(ctx, b.ID, 90*time.Second)
	if err != nil {
		return "", "", fmt.Errorf("the box did not wake in time")
	}
	_, _ = c.Run(ctx, b.ID, EnsureCuaCommand(), 15*time.Second)
	u, err := c.DesktopURL(ctx, b.ID, 60*time.Second)
	return u, ready.State, err
}

// Sleep archives the box after asking Chrome to flush.
func (c *Client) Sleep(ctx context.Context, slug string) error {
	b, err := c.Find(ctx, slug)
	if err != nil {
		return err
	}
	if b == nil {
		return fmt.Errorf("no computer for this bot")
	}
	_, _ = c.Run(ctx, b.ID, QuiesceBrowserCommand(), 5*time.Second)
	return c.Stop(ctx, b.ID)
}

// Exec runs an owner-scoped console command.
func (c *Client) Exec(ctx context.Context, slug, command string) (CommandResult, error) {
	if len(command) > MaxCommandLength {
		return CommandResult{}, fmt.Errorf("command is too long (maximum %d characters)", MaxCommandLength)
	}
	b, err := c.Find(ctx, slug)
	if err != nil {
		return CommandResult{}, err
	}
	if b == nil {
		return CommandResult{}, fmt.Errorf("no computer for this bot yet")
	}
	if _, err := c.WaitReady(ctx, b.ID, 60*time.Second); err != nil {
		return CommandResult{}, fmt.Errorf("box did not wake")
	}
	res, err := c.Run(ctx, b.ID, IsolatedCommand(command), 120*time.Second)
	if err != nil {
		return res, err
	}
	res.Stdout = tail(res.Stdout, 4000)
	res.Stderr = tail(res.Stderr, 2000)
	return res, nil
}

// Screenshot captures the panel frame in two hops: scrot to a JPEG on the
// box, then the bytes over HTTP. Base64 over command stdout is not
// reliable for full-size frames on this provider.
func (c *Client) Screenshot(ctx context.Context, boxID string) ([]byte, error) {
	out, err := c.Run(ctx, boxID, PanelScreenshotCommand(), 60*time.Second)
	if err != nil {
		return nil, err
	}
	if !strings.Contains(out.Stdout, "captured") {
		return nil, fmt.Errorf("%s", firstNonEmpty(strings.TrimSpace(out.Stderr), "screen capture failed on the box"))
	}
	data, err := c.ReadFileBase64(ctx, boxID, PanelPath)
	if err != nil {
		return nil, err
	}
	return base64.StdEncoding.DecodeString(data)
}

func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}
