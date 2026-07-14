package openuiapp

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
)

func TestEmbeddedPromptMatchesContractHash(t *testing.T) {
	prompt := SystemPrompt()
	if !strings.Contains(prompt, `root = App`) || !strings.Contains(prompt, "wuphf_create_task") {
		t.Fatal("embedded prompt is missing the OpenUI App component/tool contract")
	}
	sum := sha256.Sum256([]byte(prompt + "\n"))
	if got := hex.EncodeToString(sum[:]); got != PromptHash {
		t.Fatalf("embedded prompt hash = %s, want %s", got, PromptHash)
	}
}
