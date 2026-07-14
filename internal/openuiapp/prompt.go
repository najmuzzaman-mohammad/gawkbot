package openuiapp

import (
	_ "embed"
	"strings"
)

const (
	Version         = "0.5"
	Library         = "wuphf-app-v1"
	LibraryHash     = "06e4b7ef3e2e2ca65a3cbe9b966d502210270331b475c21ab99ad5e90d51489e"
	PromptHash      = "14071ce0fde9a810f3047a5a8297a39bdaceb7c10aeae3d210cba39eb6c25e97"
	ProviderVersion = "1"
)

//go:embed system_prompt.txt
var systemPrompt string

func SystemPrompt() string { return strings.TrimSpace(systemPrompt) }
