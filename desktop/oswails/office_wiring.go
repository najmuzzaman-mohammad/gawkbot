package main

import "github.com/nex-crm/wuphf/internal/team"

// officeBrokerWiring is what the app hands the office it boots itself,
// through the launcher's broker configurator: the part of cmd/wuphf's
// wiring (wireBrokerWorkspaces) a stop depends on. Without it the governor
// can pause dispatch but cannot end the turn already running, so ⌥Esc and
// a card's Stop would leave a bot working on the person's Mac.
func officeBrokerWiring(l *team.Launcher) func(*team.Broker) {
	return func(b *team.Broker) {
		if b == nil || l == nil {
			return
		}
		b.SetLauncherDrainer(l)
		b.SetHeadlessDispatchController(l)
	}
}
