package openuiartifact

import (
	_ "embed"
	"strings"
)

const (
	Version     = "0.5"
	Library     = "wuphf-static-review"
	LibraryHash = "f1224a608682fd95303ede0e1227a1e17d87bd7d646630081bd42674ffe1ee85"
	PromptHash  = "ad90c14c640822b9c18aa9aa680983cffe3826644d022b7845fa9ec63b600fa9"
)

//go:embed system_prompt.txt
var systemPrompt string

func SystemPrompt() string {
	return strings.TrimSpace(systemPrompt)
}
