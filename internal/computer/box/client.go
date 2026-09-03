// Package box rents a bot its cloud computer from ascii.dev Box: one
// persistent Linux VM per bot with a desktop, reached only through the
// provider's REST command endpoint. Stop pauses billing while the disk
// survives; Join always mints a fresh desktop URL because stream tokens
// rotate on every state change.
//
// Ported from milind-soni/OpenMausBot (Apache-2.0) server/box.ts and
// server/remote-computer.ts.
package box

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// DefaultAPI is the provider endpoint; tests point it at a stub.
const DefaultAPI = "https://ascii.dev/api/box/v1"

// BillingURL is where a plan or the 7-day trial is started. The plain
// dashboard link, never the provider's token-bearing one.
const BillingURL = "https://box.ascii.dev/box/dashboard?tab=billing"

var readyStates = map[string]bool{"idle": true, "ready": true, "running": true}

const (
	defaultBoxTTLSeconds = 8 * 60 * 60
	trialBoxTTLSeconds   = 2 * 60 * 60
)

// Box is the provider's view of one machine.
type Box struct {
	ID               string `json:"id"`
	Name             string `json:"name"`
	State            string `json:"state"`
	DesktopAvailable *bool  `json:"desktopAvailable,omitempty"`
}

// Ready reports whether commands will run right now.
func (b Box) Ready() bool { return readyStates[b.State] }

// CommandResult is one synchronous shell run on the box.
type CommandResult struct {
	OK       bool
	ExitCode *int
	Stdout   string
	Stderr   string
}

// Client talks to the Box API for one account.
type Client struct {
	API   string
	Token string
	HTTP  *http.Client

	mu  sync.Mutex
	ids map[string]string // bot slug -> box id
}

// NewClient returns a client for a token.
func NewClient(token string) *Client {
	return &Client{API: DefaultAPI, Token: token, HTTP: &http.Client{Timeout: 150 * time.Second}}
}

// Configured reports whether a token is present.
func (c *Client) Configured() bool { return c != nil && strings.TrimSpace(c.Token) != "" }

func (c *Client) do(ctx context.Context, method, path string, body any, timeout time.Duration) (int, map[string]any, error) {
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return 0, nil, err
		}
		reader = bytes.NewReader(payload)
	}
	if timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	req, err := http.NewRequestWithContext(ctx, method, c.API+path, reader)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Content-Type", "application/json")
	res, err := c.HTTP.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(io.LimitReader(res.Body, 32<<20)).Decode(&out)
	return res.StatusCode, out, nil
}

func ok(status int, body map[string]any) bool {
	if status < 200 || status >= 300 {
		return false
	}
	if v, present := body["ok"]; present {
		if b, isBool := v.(bool); isBool && !b {
			return false
		}
	}
	return true
}

func boxFrom(body map[string]any) *Box {
	raw, _ := body["box"].(map[string]any)
	if raw == nil {
		return nil
	}
	b := &Box{}
	b.ID, _ = raw["id"].(string)
	b.Name, _ = raw["name"].(string)
	b.State, _ = raw["state"].(string)
	if v, isBool := raw["desktopAvailable"].(bool); isBool {
		b.DesktopAvailable = &v
	}
	if b.ID == "" {
		return nil
	}
	return b
}

// NameFor is the deterministic per-bot box name; the digest suffix
// prevents truncated-slug collisions.
func NameFor(slug string) string {
	digest := sha256.Sum256([]byte(slug))
	hash := hex.EncodeToString(digest[:])[:6]
	clean := strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			return r
		}
		return -1
	}, strings.ToLower(slug))
	if len(clean) > 8 {
		clean = clean[:8]
	}
	return "gb-" + clean + "-" + hash
}

// Find resolves the bot's box. Listing is the most expensive call on
// any hot path, so the id is cached once known and re-listed only when a
// direct read fails.
func (c *Client) Find(ctx context.Context, slug string) (*Box, error) {
	c.mu.Lock()
	cached := c.ids[slug]
	c.mu.Unlock()
	if cached != "" {
		status, body, err := c.do(ctx, http.MethodGet, "/boxes/"+cached, nil, 20*time.Second)
		if err == nil && ok(status, body) {
			if b := boxFrom(body); b != nil && b.State != "error" {
				return b, nil
			}
		}
		c.mu.Lock()
		delete(c.ids, slug)
		c.mu.Unlock()
	}
	status, body, err := c.do(ctx, http.MethodGet, "/boxes", nil, 30*time.Second)
	if err != nil {
		return nil, err
	}
	if !ok(status, body) {
		return nil, fmt.Errorf("%s", ErrorMessage(status, "box list", body))
	}
	name := NameFor(slug)
	boxes, _ := body["boxes"].([]any)
	for _, raw := range boxes {
		m, _ := raw.(map[string]any)
		if m == nil {
			continue
		}
		if b := boxFrom(map[string]any{"box": m}); b != nil && b.Name == name && b.State != "error" {
			c.mu.Lock()
			if c.ids == nil {
				c.ids = map[string]string{}
			}
			c.ids[slug] = b.ID
			c.mu.Unlock()
			return b, nil
		}
	}
	return nil, nil
}

// WaitReady polls until the box runs, nudging an archived box to resume.
func (c *Client) WaitReady(ctx context.Context, boxID string, budget time.Duration) (*Box, error) {
	deadline := time.Now().Add(budget)
	for time.Now().Before(deadline) {
		status, body, err := c.do(ctx, http.MethodGet, "/boxes/"+boxID, nil, 20*time.Second)
		if err != nil {
			return nil, err
		}
		b := boxFrom(body)
		if ok(status, body) && b != nil {
			if b.Ready() {
				return b, nil
			}
			if b.State == "error" {
				return b, fmt.Errorf("the box is in an error state")
			}
			if b.State == "archived" {
				_, _, _ = c.do(ctx, http.MethodPost, "/boxes/"+boxID+"/resume", nil, 30*time.Second)
			}
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(2500 * time.Millisecond):
		}
	}
	return nil, fmt.Errorf("the box did not become ready within %s", budget)
}

// Run executes a shell command synchronously on the box.
func (c *Client) Run(ctx context.Context, boxID, command string, timeout time.Duration) (CommandResult, error) {
	if timeout <= 0 {
		timeout = 120 * time.Second
	}
	status, body, err := c.do(ctx, http.MethodPost, "/boxes/"+boxID+"/commands", map[string]any{"command": command}, timeout)
	if err != nil {
		return CommandResult{}, err
	}
	res := CommandResult{}
	if code, isNum := body["exitCode"].(float64); isNum {
		v := int(code)
		res.ExitCode = &v
	}
	res.Stdout, _ = body["stdout"].(string)
	res.Stderr, _ = body["stderr"].(string)
	res.OK = status >= 200 && status < 300 && res.ExitCode != nil && *res.ExitCode == 0
	if !res.OK && res.Stderr == "" {
		if msg, isStr := body["message"].(string); isStr {
			res.Stderr = msg
		} else if status >= 300 {
			res.Stderr = fmt.Sprintf("HTTP %d", status)
		}
	}
	if status == http.StatusConflict {
		return res, &NotRunningError{Code: errorCode(body)}
	}
	return res, nil
}

// NotRunningError is the provider's 409 for an asleep or starting box.
type NotRunningError struct{ Code string }

func (e *NotRunningError) Error() string { return "the box is not running (" + e.Code + ")" }

func errorCode(body map[string]any) string {
	if code, isStr := body["code"].(string); isStr {
		return code
	}
	if e, isMap := body["error"].(map[string]any); isMap {
		if code, isStr := e["code"].(string); isStr {
			return code
		}
	}
	return ""
}

// ErrorMessage turns a provider refusal into something a person can act
// on, preferring the provider's own wording.
func ErrorMessage(status int, what string, body map[string]any) string {
	theirs := ""
	if msg, isStr := body["message"].(string); isStr {
		theirs = strings.TrimSpace(msg)
	}
	switch status {
	case http.StatusPaymentRequired:
		// The provider's own link may embed a session token; always point at
		// the plain billing page and mention the trial, which counts.
		return strings.TrimSpace(strings.Join([]string{
			firstNonEmpty(theirs, "ascii.dev needs a plan before it will start a box. The 7-day trial counts."),
			"Start it at " + BillingURL,
		}, " "))
	case http.StatusUnauthorized, http.StatusForbidden:
		return "your box token was rejected by ascii.dev — open Settings and paste a current token (it starts with box_)"
	case http.StatusTooManyRequests:
		return firstNonEmpty(theirs, "ascii.dev is rate-limiting this account — wait a minute and try again")
	}
	if theirs != "" {
		return what + " failed: " + theirs
	}
	return fmt.Sprintf("%s failed (%d)", what, status)
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// VerifyToken asks the provider whether a token is real before it is saved.
func VerifyToken(ctx context.Context, api, token string) error {
	c := &Client{API: api, Token: token, HTTP: &http.Client{Timeout: 20 * time.Second}}
	status, _, err := c.do(ctx, http.MethodGet, "/boxes", nil, 20*time.Second)
	if err != nil {
		return fmt.Errorf("couldn't reach ascii.dev to check that token — check your connection and retry")
	}
	switch {
	case status >= 200 && status < 300:
		return nil
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		if strings.HasPrefix(token, "box_") {
			return fmt.Errorf("ascii.dev rejected that token — it may have been revoked or expired")
		}
		return fmt.Errorf("that doesn't look like a box API key: they start with box_")
	}
	return fmt.Errorf("ascii.dev returned %d for that token — try again in a moment", status)
}

// Create makes a fresh box with provider-side env injection off, retrying
// once at the trial TTL when the provider says so.
func (c *Client) Create(ctx context.Context) (*Box, error) {
	request := func(ttl int) (int, map[string]any, error) {
		return c.do(ctx, http.MethodPost, "/boxes", map[string]any{"ttlSeconds": ttl, "noEnv": true}, 60*time.Second)
	}
	status, body, err := request(defaultBoxTTLSeconds)
	if err != nil {
		return nil, err
	}
	if !ok(status, body) && errorCode(body) == "trial_auto_stop_required" {
		status, body, err = request(trialBoxTTLSeconds)
		if err != nil {
			return nil, err
		}
	}
	if !ok(status, body) {
		return nil, fmt.Errorf("%s", ErrorMessage(status, "box create", body))
	}
	b := boxFrom(body)
	if b == nil {
		return nil, fmt.Errorf("box create returned no box")
	}
	return b, nil
}

// Rename sets the deterministic per-bot name.
func (c *Client) Rename(ctx context.Context, boxID, name string) error {
	status, body, err := c.do(ctx, http.MethodPatch, "/boxes/"+boxID, map[string]any{"name": name}, 30*time.Second)
	if err != nil {
		return err
	}
	if !ok(status, body) {
		return fmt.Errorf("%s", ErrorMessage(status, "box naming", body))
	}
	return nil
}

// Delete removes a box entirely; used only to roll back a failed create.
func (c *Client) Delete(ctx context.Context, boxID string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, c.API+"/boxes/"+boxID, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("X-Ascii-Confirm-Delete", boxID)
	res, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	res.Body.Close()
	if res.StatusCode >= 300 {
		return fmt.Errorf("box delete failed (%d)", res.StatusCode)
	}
	return nil
}

// Stop archives the box: billing pauses, disk survives.
func (c *Client) Stop(ctx context.Context, boxID string) error {
	_, _, err := c.do(ctx, http.MethodPost, "/boxes/"+boxID+"/stop", nil, 30*time.Second)
	return err
}

// Remember caches a slug's box id after a create.
func (c *Client) Remember(slug, boxID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.ids == nil {
		c.ids = map[string]string{}
	}
	c.ids[slug] = boxID
}

// Forget drops the cached id.
func (c *Client) Forget(slug string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.ids, slug)
}

// DesktopURL mints a fresh desktop link. VNC first (plain WebSocket, works
// on P2P-blocking networks), WebRTC as fallback.
func (c *Client) DesktopURL(ctx context.Context, boxID string, budget time.Duration) (string, error) {
	deadline := time.Now().Add(budget)
	for time.Now().Before(deadline) {
		_, body, err := c.do(ctx, http.MethodPost, "/boxes/"+boxID+"/desktop?vnc=1", nil, 30*time.Second)
		if err != nil {
			return "", err
		}
		if u := desktopURLFrom(body); u != "" {
			return u, nil
		}
		if prov, isBool := body["provisioning"].(bool); !isBool || !prov {
			break
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(3 * time.Second):
		}
	}
	_, body, err := c.do(ctx, http.MethodPost, "/boxes/"+boxID+"/desktop", nil, 30*time.Second)
	if err != nil {
		return "", err
	}
	if u := desktopURLFrom(body); u != "" {
		return u, nil
	}
	return "", fmt.Errorf("box desktop link could not be created")
}

// ViewerLink shapes the provider's desktop link for the panel iframe. The
// noVNC page ascii.dev serves takes the same query switches as our local
// viewer: scale to the frame, show a dot cursor, and refuse input while
// the bot is driving. Other viewers pass through untouched.
func ViewerLink(raw string, viewOnly bool) string {
	u, err := url.Parse(raw)
	if err != nil || !strings.HasSuffix(u.Path, "/vnc.html") {
		return raw
	}
	q := u.Query()
	q.Set("autoconnect", "true")
	q.Set("reconnect", "true")
	q.Set("resize", "scale")
	q.Set("show_dot", "true")
	q.Set("view_only", strconv.FormatBool(viewOnly))
	u.RawQuery = q.Encode()
	return u.String()
}

func desktopURLFrom(body map[string]any) string {
	if u, isStr := body["desktopUrl"].(string); isStr && u != "" {
		return u
	}
	if u, isStr := body["url"].(string); isStr && u != "" {
		return u
	}
	return ""
}

// ReadFileBase64 reads a file off the box: raw artifact bytes when the API
// supports it, else the files API.
func (c *Client) ReadFileBase64(ctx context.Context, boxID, path string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.API+"/boxes/"+boxID+"/artifacts?path="+url.QueryEscape(path), nil)
	if err == nil {
		req.Header.Set("Authorization", "Bearer "+c.Token)
		if res, err := c.HTTP.Do(req); err == nil {
			data, _ := io.ReadAll(io.LimitReader(res.Body, 32<<20))
			res.Body.Close()
			if res.StatusCode == http.StatusOK && len(data) > 0 {
				return base64.StdEncoding.EncodeToString(data), nil
			}
		}
	}
	status, body, err := c.do(ctx, http.MethodGet, "/boxes/"+boxID+"/files?path="+url.QueryEscape(path)+"&encoding=base64", nil, 60*time.Second)
	if err != nil {
		return "", err
	}
	content, _ := body["content"].(string)
	if !ok(status, body) || content == "" {
		return "", fmt.Errorf("could not read %s from the box", path)
	}
	return content, nil
}

// Limits is the account's plan gate as the API reports it to a key.
type Limits struct {
	CanStart      *bool  `json:"canStart"`
	BlockedReason string `json:"blockedReason"`
	AccessTier    string `json:"accessTier"`
	PlanName      string `json:"planName"`
	TrialLine     string `json:"trialLine"`
}

// Limits reads GET /limits. A missing canStart is inferred from
// blockedReason so older API shapes still gate correctly.
func (c *Client) Limits(ctx context.Context) (*Limits, error) {
	status, body, err := c.do(ctx, http.MethodGet, "/limits", nil, 20*time.Second)
	if err != nil {
		return nil, err
	}
	if !ok(status, body) {
		return nil, fmt.Errorf("%s", ErrorMessage(status, "limits", body))
	}
	raw, _ := json.Marshal(body)
	var out Limits
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	if out.CanStart == nil {
		can := out.BlockedReason == ""
		out.CanStart = &can
	}
	return &out, nil
}

// Me reads GET /me: who the key belongs to.
func (c *Client) Me(ctx context.Context) (login, email string, err error) {
	status, body, err := c.do(ctx, http.MethodGet, "/me", nil, 20*time.Second)
	if err != nil {
		return "", "", err
	}
	if !ok(status, body) {
		return "", "", fmt.Errorf("%s", ErrorMessage(status, "me", body))
	}
	user, _ := body["user"].(map[string]any)
	login, _ = user["login"].(string)
	email, _ = user["email"].(string)
	return login, email, nil
}
