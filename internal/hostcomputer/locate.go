package hostcomputer

import (
	"context"
	"strings"
)

// Element is one row of a window's accessibility tree with its place on
// screen, in global points.
type Element struct {
	Index int    `json:"element_index"`
	Token string `json:"element_token"`
	Role  string `json:"role"`
	Label string `json:"label"`
	Value string `json:"value"`
	Frame Rect   `json:"frame"`
}

// locateMaxElements bounds one locate read; a window's chrome and main
// controls sit near the top of the tree.
const locateMaxElements = 600

// ReadElements walks one window's tree and returns its elements with
// frames. Needs Accessibility.
func ReadElements(ctx context.Context, c Caller, pid, windowID int, query string) ([]Element, error) {
	args := map[string]any{
		"pid": pid, "window_id": windowID, "capture_mode": "ax", "tree_format": "elements",
		"include_screenshot": false, "max_elements": locateMaxElements,
	}
	if q := strings.TrimSpace(query); q != "" {
		args["query"] = q
	}
	res, err := c.Call(ctx, "get_window_state", args)
	if err != nil {
		return nil, err
	}
	if err := res.Err(); err != nil {
		return nil, err
	}
	var out struct {
		Elements []Element `json:"elements"`
	}
	if err := res.Decode(&out); err != nil {
		return nil, err
	}
	return out.Elements, nil
}

// Locate finds the element a person would mean by a few words: the
// visible name first, exact before partial, controls before containers.
// Zero-size rows (hidden or virtualised) never win.
func Locate(elements []Element, query string) (Element, bool) {
	q := strings.ToLower(strings.TrimSpace(query))
	if q == "" {
		return Element{}, false
	}
	var best Element
	bestScore := 0
	for _, el := range elements {
		if el.Frame.W < 2 || el.Frame.H < 2 {
			continue
		}
		label := strings.ToLower(strings.TrimSpace(el.Label))
		value := strings.ToLower(strings.TrimSpace(el.Value))
		score := 0
		switch {
		case label == q:
			score = 100
		case value == q:
			score = 90
		case strings.HasPrefix(label, q):
			score = 70
		case strings.Contains(label, q):
			score = 50
		case strings.Contains(value, q):
			score = 40
		case strings.Contains(strings.ToLower(el.Role), q):
			score = 10
		}
		if score == 0 {
			continue
		}
		if isControl(el.Role) {
			score += 5
		}
		if score > bestScore {
			best, bestScore = el, score
		}
	}
	return best, bestScore > 0
}

// isControl names the roles a person points at: buttons, fields, links,
// menu items, rows; not groups and windows.
func isControl(role string) bool {
	r := strings.ToLower(strings.TrimPrefix(role, "AX"))
	switch r {
	case "button", "textfield", "textarea", "link", "menuitem", "menubaritem", "checkbox", "radiobutton",
		"popupbutton", "combobox", "tab", "row", "cell", "image", "slider", "toolbar", "statictext", "searchfield":
		return true
	}
	return false
}

// PointerAt is where a pointer sits for an element: just inside its
// right edge, vertically centred, so the tip touches the control without
// covering its words.
func PointerAt(el Element) (float64, float64) {
	x := el.Frame.X + el.Frame.W - 4
	y := el.Frame.Y + el.Frame.H/2
	if el.Frame.W > 160 {
		x = el.Frame.X + 24
	}
	return x, y
}
