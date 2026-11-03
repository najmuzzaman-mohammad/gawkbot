package hostcomputer

import (
	"strings"
	"testing"
)

func TestValidateSceneBoundsWhatReachesTheScreen(t *testing.T) {
	ok := Scene{Items: []SceneItem{{Kind: "pointer", X: 10, Y: 20, Label: "  Save\tnow\n "}}}
	if err := ValidateScene(&ok); err != nil {
		t.Fatal(err)
	}
	if ok.TTLMs != defaultSceneMs || ok.Items[0].Label != "Save now" {
		t.Fatalf("defaults: %+v", ok)
	}
	long := Scene{Items: []SceneItem{{Kind: "label", X: 1, Y: 1, Text: strings.Repeat("x", 500)}}}
	if err := ValidateScene(&long); err != nil || len([]rune(long.Items[0].Text)) != SceneTextMax {
		t.Fatalf("long text: %v %d", err, len([]rune(long.Items[0].Text)))
	}
	bad := []Scene{
		{},
		{Items: []SceneItem{{Kind: "laser", X: 1, Y: 1}}},
		{Items: []SceneItem{{Kind: "label", X: 1, Y: 1}}},
		{Items: []SceneItem{{Kind: "arrow", From: &Rect{X: 1, Y: 1, W: 2, H: 2}}}},
		{Items: []SceneItem{{Kind: "box"}}},
		{Items: []SceneItem{{Kind: "pointer", X: 1e9, Y: 1}}},
		{TTLMs: SceneMaxTTLMs + 1, Items: []SceneItem{{Kind: "pointer", X: 1, Y: 1}}},
		{Color: "blue", Items: []SceneItem{{Kind: "pointer", X: 1, Y: 1}}},
		{Items: make([]SceneItem, SceneMaxItems+1)},
	}
	for i, s := range bad {
		if err := ValidateScene(&s); err == nil {
			t.Fatalf("bad scene %d accepted: %+v", i, s)
		}
	}
	if !validHex("#5aA9Ff") || validHex("#5aa9f") || validHex("5aa9ff") {
		t.Fatal("hex check")
	}
}

func TestLocatePrefersTheExactVisibleNameAndControls(t *testing.T) {
	els := []Element{
		{Index: 1, Role: "AXGroup", Label: "Merge area", Frame: Rect{X: 0, Y: 0, W: 400, H: 300}},
		{Index: 2, Role: "AXStaticText", Label: "", Value: "merge when ready", Frame: Rect{X: 10, Y: 10, W: 200, H: 20}},
		{Index: 3, Role: "AXButton", Label: "Merge pull request", Frame: Rect{X: 600, Y: 400, W: 160, H: 28}},
		{Index: 4, Role: "AXButton", Label: "Merge", Frame: Rect{X: 700, Y: 500, W: 0, H: 0}},
		{Index: 5, Role: "AXButton", Label: "Cancel", Frame: Rect{X: 500, Y: 400, W: 80, H: 28}},
	}
	if el, ok := Locate(els, "merge"); !ok || el.Index != 3 {
		t.Fatalf("merge -> %+v ok=%v (the hidden exact match must lose)", el, ok)
	}
	if el, ok := Locate(els, "Cancel"); !ok || el.Index != 5 {
		t.Fatalf("Cancel -> %+v", el)
	}
	if el, ok := Locate(els, "when ready"); !ok || el.Index != 2 {
		t.Fatalf("value match -> %+v", el)
	}
	if _, ok := Locate(els, "download"); ok {
		t.Fatal("found a control that is not there")
	}
	if _, ok := Locate(els, "  "); ok {
		t.Fatal("an empty query found something")
	}
	x, y := PointerAt(els[2])
	if x != 600+160-4 || y != 414 {
		t.Fatalf("pointer at %v,%v", x, y)
	}
	x, _ = PointerAt(Element{Frame: Rect{X: 100, Y: 0, W: 400, H: 20}})
	if x != 124 {
		t.Fatalf("wide element pointer x = %v", x)
	}
}
