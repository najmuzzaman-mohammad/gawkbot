package openuiapp

import (
	_ "embed"
	"strings"
)

const (
	Version         = "0.5"
	Library         = "wuphf-app-v1"
	LibraryHash     = "a399729367a23238169e75cda54ec4c76c43d6d5e7c1e44aa2fe98ad7f6413c2"
	PromptHash      = "5ee6b3ae5a2246afb0fe2b621be1bff7b6b74135fcb0ea13421ea3ed38ca1e62"
	ProviderVersion = "1"
)

//go:embed system_prompt.txt
var systemPrompt string

func SystemPrompt() string { return strings.TrimSpace(systemPrompt) }
