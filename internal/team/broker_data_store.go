package team

// broker_data_store.go is the single place the real data-space store is wired
// into the broker. It exists on its own so broker_data.go stays testable
// against the dataspace.Store INTERFACE alone: the handlers never name a
// concrete implementation, and a test swaps newDataStore for a fake.
//
// The path lives in internal/dataspace, not here, so the broker and the MCP
// tools cannot disagree about where a space's SQLite file is.

import "github.com/nex-crm/wuphf/internal/dataspace"

func init() {
	newDataStore = func(root string) (dataspace.Store, error) {
		if root == "" {
			return dataspace.New()
		}
		return dataspace.Open(root)
	}
}
