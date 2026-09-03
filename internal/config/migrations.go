package config

// MigrationStatus describes what a one-shot migration observed and changed,
// returned to the caller so broker init can log a system message.
type MigrationStatus struct {
	OpenclawBridgesMoved int // legacy bindings converted into per-bot Provider values
}

// MigrateOpenclawBridgesFromConfig strips `openclaw_bridges` from the persisted
// config and returns the old values so the caller (broker) can move them onto
// the matching office members as ProviderBinding.Openclaw entries.
//
// Idempotent: calling it twice is safe. The first call returns the bindings
// and clears the field; subsequent calls see an empty field and return nil.
//
// This lives in the config package (not team) because it mutates config
// state. The team package owns the "write to member" half.
func MigrateOpenclawBridgesFromConfig() ([]OpenclawBridgeBinding, MigrationStatus, error) {
	cfg, err := Load()
	if err != nil {
		return nil, MigrationStatus{}, err
	}
	if len(cfg.OpenclawBridges) == 0 {
		return nil, MigrationStatus{}, nil
	}
	legacy := cfg.OpenclawBridges
	cfg.OpenclawBridges = nil
	if err := Save(cfg); err != nil {
		return nil, MigrationStatus{}, err
	}
	return legacy, MigrationStatus{OpenclawBridgesMoved: len(legacy)}, nil
}
