package main

import (
	"path/filepath"
	"testing"

	"github.com/nex-crm/wuphf/internal/team"
)

func TestTheAppsOwnOfficeCanEndARunningTurn(t *testing.T) {
	b := team.NewBrokerAt(filepath.Join(t.TempDir(), "broker-state.json"))
	if b.GovernorCanCancelTurns() {
		t.Fatal("a fresh broker claims it can cancel turns")
	}
	officeBrokerWiring(&team.Launcher{})(b)
	if !b.GovernorCanCancelTurns() {
		t.Fatal("the app's office cannot end a running turn: a stop would only pause")
	}
	officeBrokerWiring(nil)(nil) // nothing to wire is not a crash
}
