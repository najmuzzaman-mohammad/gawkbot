package openuiartifact

import (
	_ "embed"
	"strings"
)

const (
	Version     = "0.5"
	Library     = "wuphf-static-review"
	LibraryHash = "f1224a608682fd95303ede0e1227a1e17d87bd7d646630081bd42674ffe1ee85"
	PromptHash  = "53ec2f5d8a27617ca1e91b13261bb782b1c02eb6c4049a30528b7fb5f890cd58"
)

//go:embed system_prompt.txt
var systemPrompt string

func SystemPrompt() string {
	return strings.TrimSpace(systemPrompt)
}
