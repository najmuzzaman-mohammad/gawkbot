package openuiartifact

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
)

func TestEmbeddedPromptMatchesContractHash(t *testing.T) {
	prompt := SystemPrompt()
	if !strings.Contains(prompt, "root = Stack") || !strings.Contains(prompt, "OpenUI Lang v0.5") {
		t.Fatalf("embedded prompt is missing the OpenUI artifact contract")
	}
	// The generated file has one trailing newline; SystemPrompt intentionally
	// trims it for tool descriptions, so hash the file shape here.
	sum := sha256.Sum256([]byte(prompt + "\n"))
	if got := hex.EncodeToString(sum[:]); got != PromptHash {
		t.Fatalf("embedded prompt hash = %s, want %s; regenerate the prompt and update the pinned hash", got, PromptHash)
	}
}
