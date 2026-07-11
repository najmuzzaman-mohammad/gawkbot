package openuiapp

import (
	_ "embed"
	"strings"
)

const (
	Version         = "0.5"
	Library         = "wuphf-app-v1"
	LibraryHash     = "06e4b7ef3e2e2ca65a3cbe9b966d502210270331b475c21ab99ad5e90d51489e"
	PromptHash      = "f9c61fa5caad8f40b6c385149a3ad3dcecab26385873b031e806191863b15059"
	ProviderVersion = "1"
)

//go:embed system_prompt.txt
var systemPrompt string

func SystemPrompt() string { return strings.TrimSpace(systemPrompt) }
