package hostcomputer

import (
	"context"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

// ScreenContext is what is in front of the person right now: the app and
// its frontmost window, and for a browser the page's host when it can be
// read. It is kept in memory only, never written anywhere, and only while
// something is asking for it.
type ScreenContext struct {
	App         string    `json:"app"`
	BundleID    string    `json:"bundle_id"`
	PID         int       `json:"pid,omitempty"`
	WindowID    int       `json:"window_id,omitempty"`
	WindowTitle string    `json:"window_title,omitempty"`
	URL         string    `json:"url,omitempty"`
	Domain      string    `json:"domain,omitempty"`
	At          time.Time `json:"at"`
}

// WatchInterval is how often the watcher polls while active.
var WatchInterval = time.Second

// Watcher polls the frontmost app and window while someone is looking
// (the notch is open, or the talk key is held). Each SetActive(true) is
// matched by a SetActive(false); the loop runs only while the count is
// above zero, so an idle Mac costs nothing.
type Watcher struct {
	client Caller
	// ReadURL, when true, also reads a browser's address bar through the
	// accessibility tree. That read needs Accessibility and walks one
	// window, so it runs only on a change of window, not every tick.
	ReadURL bool
	// Frontmost, when set, names the app in front. The desktop shell asks
	// the system directly (no permission, exact); without it the driver's
	// own "active" flag is used, which some builds leave unset.
	Frontmost func() (App, bool)

	mu       sync.Mutex
	active   int
	cancel   context.CancelFunc
	last     ScreenContext
	ok       bool
	lastKey  string
	lastHost string
	// inflight is closed when the address-bar read for lastKey finishes,
	// so a second reader of the same window waits for it instead of
	// walking the tree again or answering without the host.
	inflight chan struct{}
}

// NewWatcher watches through c.
func NewWatcher(c Caller) *Watcher {
	return &Watcher{client: c}
}

// SetActive adds or removes one interested party.
func (w *Watcher) SetActive(on bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if on {
		w.active++
		if w.active == 1 {
			ctx, cancel := context.WithCancel(context.Background())
			w.cancel = cancel
			go w.loop(ctx)
		}
		return
	}
	if w.active == 0 {
		return
	}
	w.active--
	if w.active == 0 {
		w.cancel()
		w.cancel = nil
		w.last, w.ok, w.lastKey, w.lastHost, w.inflight = ScreenContext{}, false, "", "", nil
	}
}

// Active reports whether anyone is watching.
func (w *Watcher) Active() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.active > 0
}

// Snapshot returns the last reading, if the watcher is active and has one.
func (w *Watcher) Snapshot() (ScreenContext, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.last, w.ok
}

func (w *Watcher) loop(ctx context.Context) {
	for {
		_, _ = w.Refresh(ctx)
		select {
		case <-ctx.Done():
			return
		case <-time.After(WatchInterval):
		}
	}
}

// Refresh takes one reading now and remembers it.
func (w *Watcher) Refresh(ctx context.Context) (ScreenContext, error) {
	var front App
	if w.Frontmost != nil {
		front, _ = w.Frontmost()
	} else {
		apps, err := ListApps(ctx, w.client)
		if err != nil {
			return ScreenContext{}, err
		}
		for _, a := range apps {
			if a.Active && a.Running {
				front = a
				break
			}
		}
	}
	sc := ScreenContext{App: front.Name, BundleID: front.BundleID, PID: front.PID, At: time.Now()}
	if front.PID > 0 {
		if windows, err := ListWindows(ctx, w.client, front.PID, true); err == nil {
			if win, ok := Frontmost(windows); ok {
				sc.WindowID, sc.WindowTitle = win.WindowID, win.Title
			}
		}
	}
	key := sc.BundleID + "|" + itoa(sc.WindowID) + "|" + sc.WindowTitle
	readable := w.ReadURL && IsBrowser(sc.BundleID) && sc.WindowID > 0
	// Claim the window before reading its address bar, so a second reading
	// that overlaps this one (the poll and an on-demand refresh) does not
	// walk the same tree twice.
	w.mu.Lock()
	var wait chan struct{}
	needRead := false
	if key != w.lastKey {
		w.lastKey, w.lastHost, w.inflight = key, "", nil
		if readable {
			needRead = true
			w.inflight = make(chan struct{})
		}
	} else {
		wait = w.inflight
	}
	host := w.lastHost
	w.mu.Unlock()
	if needRead {
		host, _ = AddressBarURL(ctx, w.client, sc.PID, sc.WindowID)
		w.mu.Lock()
		if w.lastKey == key {
			w.lastHost = host
			if w.inflight != nil {
				close(w.inflight)
				w.inflight = nil
			}
		}
		w.mu.Unlock()
	} else if wait != nil {
		select {
		case <-wait:
		case <-ctx.Done():
		}
		w.mu.Lock()
		if w.lastKey == key {
			host = w.lastHost
		}
		w.mu.Unlock()
	}
	if readable && host != "" {
		sc.URL = host
		sc.Domain = DomainOf(host)
	}
	w.mu.Lock()
	if w.active > 0 {
		w.last, w.ok = sc, true
	}
	w.mu.Unlock()
	return sc, nil
}

// browserBundles are the browsers whose address bar the watcher reads.
var browserBundles = map[string]bool{
	"com.google.Chrome":                 true,
	"com.google.Chrome.canary":          true,
	"com.apple.Safari":                  true,
	"com.brave.Browser":                 true,
	"com.microsoft.edgemac":             true,
	"company.thebrowser.Browser":        true,
	"org.mozilla.firefox":               true,
	"com.vivaldi.Vivaldi":               true,
	"com.operasoftware.Opera":           true,
	"com.kagi.kagimacOS":                true,
	"app.zen-browser.zen":               true,
	"com.sigmaos.sigmaos.macos":         true,
	"com.apple.SafariTechnologyPreview": true,
}

// IsBrowser reports whether the bundle is a browser the watcher knows.
func IsBrowser(bundleID string) bool { return browserBundles[bundleID] }

var urlInText = regexp.MustCompile(`https?://[^\s"'<>)\]]+`)

// AddressBarURL reads a browser window's address bar from its
// accessibility tree: the text field whose label names the address or
// search bar, or failing that the first URL on such a line. Needs
// Accessibility; without it the driver answers with an error and this
// returns "".
func AddressBarURL(ctx context.Context, c Caller, pid, windowID int) (string, error) {
	res, err := c.Call(ctx, "get_window_state", map[string]any{
		"pid": pid, "window_id": windowID, "capture_mode": "ax", "tree_format": "both", "include_screenshot": false,
		"query": "address", "max_elements": 400, "max_depth": 12,
	})
	if err != nil {
		return "", err
	}
	if err := res.Err(); err != nil {
		return "", err
	}
	var out struct {
		Elements []struct {
			Role  string `json:"role"`
			Label string `json:"label"`
			Value string `json:"value"`
		} `json:"elements"`
		TreeMarkdown string `json:"tree_markdown"`
	}
	_ = res.Decode(&out)
	for _, el := range out.Elements {
		label := strings.ToLower(el.Label)
		if (strings.Contains(label, "address") || strings.Contains(label, "search bar") || strings.Contains(label, "location")) && el.Value != "" {
			return normalizeURL(el.Value), nil
		}
	}
	for _, line := range strings.Split(out.TreeMarkdown, "\n") {
		lower := strings.ToLower(line)
		if strings.Contains(lower, "address") || strings.Contains(lower, "search bar") || strings.Contains(lower, "location") {
			if m := urlInText.FindString(line); m != "" {
				return normalizeURL(m), nil
			}
		}
	}
	return "", nil
}

func normalizeURL(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	if !strings.Contains(s, "://") {
		if !strings.Contains(s, ".") || strings.ContainsAny(s, " \t") {
			return ""
		}
		s = "https://" + s
	}
	u, err := url.Parse(s)
	if err != nil || u.Host == "" {
		return ""
	}
	// Only the scheme, host and path travel on; never a query or fragment,
	// which is where tokens and search terms live.
	u.RawQuery, u.Fragment, u.User = "", "", nil
	return u.String()
}

// DomainOf is the host of a URL without a leading "www.".
func DomainOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	host := strings.ToLower(u.Hostname())
	return strings.TrimPrefix(host, "www.")
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}
