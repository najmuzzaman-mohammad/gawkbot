package hostcomputer

import (
	"context"
	"fmt"
	"sort"
	"strings"
)

// Typed views of the driver tools the broker reads. Every helper is a thin
// parse of the driver's structured content; nothing here acts on the Mac.

// App is one entry of list_apps.
type App struct {
	Name     string `json:"name"`
	BundleID string `json:"bundle_id"`
	PID      int    `json:"pid"`
	Running  bool   `json:"running"`
	Active   bool   `json:"active"`
}

// Window is one entry of list_windows.
type Window struct {
	WindowID       int    `json:"window_id"`
	PID            int    `json:"pid"`
	AppName        string `json:"app_name"`
	Title          string `json:"title"`
	Bounds         Bounds `json:"bounds"`
	ZIndex         *int   `json:"z_index"`
	OnScreen       bool   `json:"is_on_screen"`
	OnCurrentSpace bool   `json:"on_current_space"`
	SpaceIDs       []int  `json:"space_ids"`
	Layer          int    `json:"layer"`
}

// Bounds is a window frame in screen points, origin top-left.
type Bounds struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

// Permissions is check_permissions as the host app sees it.
type Permissions struct {
	Accessibility   bool `json:"accessibility"`
	ScreenRecording bool `json:"screen_recording"`
}

// Screenshot is get_desktop_state: the PNG plus the geometry to map it
// back to screen points.
type Screenshot struct {
	PNG         []byte
	Width       int     `json:"screenshot_width"`
	Height      int     `json:"screenshot_height"`
	ScreenW     int     `json:"screen_width"`
	ScreenH     int     `json:"screen_height"`
	ScaleFactor float64 `json:"scale_factor"`
	CaptureID   string  `json:"capture_id"`
}

// ListApps returns running apps first, by name.
func ListApps(ctx context.Context, c Caller) ([]App, error) {
	res, err := c.Call(ctx, "list_apps", nil)
	if err != nil {
		return nil, err
	}
	if err := res.Err(); err != nil {
		return nil, err
	}
	var out struct {
		Apps []App `json:"apps"`
	}
	if err := res.Decode(&out); err != nil {
		return nil, err
	}
	sort.SliceStable(out.Apps, func(i, j int) bool {
		if out.Apps[i].Running != out.Apps[j].Running {
			return out.Apps[i].Running
		}
		return strings.ToLower(out.Apps[i].Name) < strings.ToLower(out.Apps[j].Name)
	})
	return out.Apps, nil
}

// ListWindows lists one app's windows (pid 0 means every app).
func ListWindows(ctx context.Context, c Caller, pid int, onScreenOnly bool) ([]Window, error) {
	args := map[string]any{}
	if pid > 0 {
		args["pid"] = pid
	}
	if onScreenOnly {
		args["on_screen_only"] = true
	}
	res, err := c.Call(ctx, "list_windows", args)
	if err != nil {
		return nil, err
	}
	if err := res.Err(); err != nil {
		return nil, err
	}
	var out struct {
		Windows []Window `json:"windows"`
	}
	if err := res.Decode(&out); err != nil {
		return nil, err
	}
	return out.Windows, nil
}

// Frontmost picks the window on top: the highest z_index among the
// on-screen windows, as the driver documents (array order means nothing).
func Frontmost(windows []Window) (Window, bool) {
	var best Window
	found := false
	for _, w := range windows {
		if !w.OnScreen || w.ZIndex == nil {
			continue
		}
		if !found || *w.ZIndex > *best.ZIndex {
			best, found = w, true
		}
	}
	return best, found
}

// CheckPermissions reads the host's grants without prompting.
func CheckPermissions(ctx context.Context, c Caller) (Permissions, error) {
	res, err := c.Call(ctx, "check_permissions", nil)
	if err != nil {
		return Permissions{}, err
	}
	var p Permissions
	if err := res.Decode(&p); err != nil {
		return Permissions{}, err
	}
	return p, nil
}

// CaptureDesktop takes one full-display picture, its long edge capped at
// maxDim pixels (0 for full size). It needs Screen Recording.
func CaptureDesktop(ctx context.Context, c Caller, maxDim int) (Screenshot, error) {
	args := map[string]any{}
	if maxDim > 0 {
		args["max_image_dimension"] = maxDim
	}
	res, err := c.Call(ctx, "get_desktop_state", args)
	if err != nil {
		return Screenshot{}, err
	}
	if err := res.Err(); err != nil {
		return Screenshot{}, err
	}
	var shot Screenshot
	if err := res.Decode(&shot); err != nil {
		return Screenshot{}, err
	}
	for _, img := range res.Images {
		if strings.HasPrefix(img.MIMEType, "image/") {
			shot.PNG = img.Data
			break
		}
	}
	if len(shot.PNG) == 0 {
		return Screenshot{}, fmt.Errorf("the driver returned no picture")
	}
	return shot, nil
}

// StartSession declares a named, colour-coded identity for one agent run;
// the daemon shows its own cursor for it until EndSession.
func StartSession(ctx context.Context, c Caller, session string) error {
	res, err := c.Call(ctx, "start_session", map[string]any{"session": session})
	if err != nil {
		return err
	}
	return res.Err()
}

// EndSession removes the session's cursor and per-session state.
func EndSession(ctx context.Context, c Caller, session string) error {
	res, err := c.Call(ctx, "end_session", map[string]any{"session": session})
	if err != nil {
		return err
	}
	return res.Err()
}

// MoveCursor glides the session's overlay cursor to a screen point. The
// person's own pointer never moves.
func MoveCursor(ctx context.Context, c Caller, session string, x, y float64) error {
	res, err := c.Call(ctx, "move_cursor", map[string]any{"session": session, "x": x, "y": y})
	if err != nil {
		return err
	}
	return res.Err()
}

// StyleCursor labels and colours a session's cursor so several agents on
// one screen can be told apart.
func StyleCursor(ctx context.Context, c Caller, session, label, color string) error {
	args := map[string]any{"session": session, "cursor_id": session}
	if label != "" {
		args["cursor_label"] = label
	}
	if color != "" {
		args["cursor_color"] = color
	}
	res, err := c.Call(ctx, "set_agent_cursor_motion", args)
	if err != nil {
		return err
	}
	return res.Err()
}
