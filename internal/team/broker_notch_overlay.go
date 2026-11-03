package team

// broker_notch_overlay.go lets the owner's surfaces draw on the screen and
// point at things: POST /notch/overlay takes a scene, DELETE clears it,
// and POST /notch/point finds a control by a few words in the window in
// front, glides the guide cursor to it and labels it. The broker never
// draws: the overlay windows live in the Mac app, so a scene goes back in
// the response and stays pending on the notch state (overlay.seq) until
// the notch page hands it to the app. That works whichever process serves
// the office. Only the owner's token may draw.

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/nex-crm/wuphf/internal/hostcomputer"
)

// guideSession is the driver cursor session the notch itself points with:
// one cursor, the brand colour, the lead's name on it.
const guideSession = "guide"

// notchPointRequest is POST /notch/point.
type notchPointRequest struct {
	// Query names the control: its visible label, or a word of it.
	Query string `json:"query,omitempty"`
	// X and Y point at a screen position instead, in screen points.
	X *float64 `json:"x,omitempty"`
	Y *float64 `json:"y,omitempty"`
	// Label is the word or two drawn beside the pointer.
	Label string `json:"label,omitempty"`
	// Seconds is how long the pointer stays; 0 means a few seconds.
	Seconds float64 `json:"seconds,omitempty"`
}

// notchPointResult says where the pointer went, with the scene to draw.
type notchPointResult struct {
	Found bool                `json:"found"`
	X     float64             `json:"x"`
	Y     float64             `json:"y"`
	Role  string              `json:"role,omitempty"`
	Name  string              `json:"name,omitempty"`
	Frame *hostcomputer.Rect  `json:"frame,omitempty"`
	Scene *hostcomputer.Scene `json:"scene,omitempty"`
	Seq   int                 `json:"seq,omitempty"`
}

// notchOverlay is the pending drawing on the notch state: the page draws
// it when seq changes; a nil scene means clear.
type notchOverlay struct {
	Seq   int                 `json:"seq"`
	Scene *hostcomputer.Scene `json:"scene"`
}

// setPendingScene remembers the scene for the page and bumps the sequence.
func (b *Broker) setPendingScene(scene *hostcomputer.Scene) int {
	h := &b.hostComputer
	h.mu.Lock()
	defer h.mu.Unlock()
	h.sceneSeq++
	h.scene = scene
	return h.sceneSeq
}

func (b *Broker) pendingOverlay() *notchOverlay {
	h := &b.hostComputer
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.sceneSeq == 0 {
		return nil
	}
	return &notchOverlay{Seq: h.sceneSeq, Scene: h.scene}
}

func (b *Broker) hostForDrawing(w http.ResponseWriter, r *http.Request) (HostComputer, bool) {
	if !b.requestHasBrokerAuth(r) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "only the owner may draw on the screen"})
		return nil, false
	}
	hc := b.hostComputerInstalled()
	if hc == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "drawing needs the Mac app open"})
		return nil, false
	}
	return hc, true
}

func (b *Broker) handleNotchOverlay(w http.ResponseWriter, r *http.Request) {
	if _, ok := b.hostForDrawing(w, r); !ok {
		return
	}
	switch r.Method {
	case http.MethodDelete:
		seq := b.setPendingScene(nil)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "seq": seq})
	case http.MethodPost:
		var scene hostcomputer.Scene
		if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&scene); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
			return
		}
		if err := hostcomputer.ValidateScene(&scene); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		seq := b.setPendingScene(&scene)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "seq": seq, "scene": scene})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (b *Broker) handleNotchPoint(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	hc, ok := b.hostForDrawing(w, r)
	if !ok {
		return
	}
	var req notchPointRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 8<<10)).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	res, status, err := b.pointAt(ctx, hc, req)
	if err != nil {
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// pointAt resolves the request to a screen point, moves the guide cursor
// there and draws the label. A query is looked up in the window in front.
func (b *Broker) pointAt(ctx context.Context, hc HostComputer, req notchPointRequest) (notchPointResult, int, error) {
	ttl := int(req.Seconds * 1000)
	if ttl <= 0 {
		ttl = 0
	}
	if ttl > hostcomputer.SceneMaxTTLMs {
		ttl = hostcomputer.SceneMaxTTLMs
	}
	out := notchPointResult{}
	switch {
	case req.X != nil && req.Y != nil:
		out.Found, out.X, out.Y = true, *req.X, *req.Y
	case strings.TrimSpace(req.Query) != "":
		driver := hc.Driver()
		if driver == nil {
			return out, http.StatusServiceUnavailable, errors.New("the computer-use driver is not running")
		}
		perms, _ := b.hostPermissions(ctx, time.Now())
		if !perms.Accessibility {
			return out, http.StatusForbidden, errors.New("gawkbot does not have Accessibility permission yet")
		}
		sc, err := hc.Screen().Refresh(ctx)
		if err != nil || sc.PID == 0 || sc.WindowID == 0 {
			return out, http.StatusConflict, errors.New("no window is in front to look in")
		}
		elements, err := hostcomputer.ReadElements(ctx, driver, sc.PID, sc.WindowID, req.Query)
		if err != nil {
			return out, http.StatusBadGateway, err
		}
		el, ok := hostcomputer.Locate(elements, req.Query)
		if !ok {
			out.Found = false
			return out, http.StatusOK, nil
		}
		out.Found = true
		out.X, out.Y = hostcomputer.PointerAt(el)
		out.Role, out.Name = el.Role, el.Label
		frame := el.Frame
		out.Frame = &frame
	default:
		return out, http.StatusBadRequest, errors.New("say what to point at: a query, or x and y")
	}
	// The driver's own cursor glides there when it can; the drawn pointer
	// and label are ours either way.
	if driver := hc.Driver(); driver != nil {
		_ = hostcomputer.StartSession(ctx, driver, guideSession)
		_ = hostcomputer.MoveCursor(ctx, driver, guideSession, out.X, out.Y)
	}
	scene := hostcomputer.PointerScene(out.X, out.Y, req.Label, ttl)
	if out.Frame != nil {
		scene.Items = append(scene.Items, hostcomputer.SceneItem{Kind: "box", Rect: out.Frame})
	}
	if err := hostcomputer.ValidateScene(&scene); err != nil {
		return out, http.StatusBadRequest, err
	}
	out.Seq = b.setPendingScene(&scene)
	out.Scene = &scene
	return out, http.StatusOK, nil
}
