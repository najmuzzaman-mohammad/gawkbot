package team

// wiki_query_rerank_bge_test.go — OFFICE-357: locks the bge cross-encoder
// client's CONTRACT independent of any running model server. The live model
// is exercised separately (it needs a bge-reranker-v2-m3 sidecar); these tests
// pin the parts that must hold regardless of the model: deterministic reorder,
// pool cap, and — most important — the additive fallback that guarantees no
// recall regression when the endpoint is down.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func bgeHits(ids ...string) []SearchHit {
	out := make([]SearchHit, len(ids))
	for i, id := range ids {
		out[i] = SearchHit{FactID: id, Snippet: id + " snippet", Score: 1.0}
	}
	return out
}

func ids(hits []SearchHit) []string {
	out := make([]string, len(hits))
	for i, h := range hits {
		out[i] = h.FactID
	}
	return out
}

// TestBgeReranker_ReordersByScore: a healthy endpoint that scores the LAST
// candidate highest must surface it at rank 1. This is the whole point of the
// stage — joint (query, doc) scoring overrides fused order on the head.
func TestBgeReranker_ReordersByScore(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		var body bgeRerankRequest
		_ = json.NewDecoder(req.Body).Decode(&body)
		// Score in reverse: last text gets the highest score.
		out := make([]bgeRerankResult, len(body.Texts))
		for i := range body.Texts {
			out[i] = bgeRerankResult{Index: i, Score: float64(len(body.Texts) - i)}
		}
		_ = json.NewEncoder(w).Encode(out)
	}))
	defer srv.Close()

	rr := &bgeReranker{endpoint: srv.URL, model: "test", client: srv.Client(), poolCap: bgeRerankPoolCap}
	got, err := rr.Rerank(context.Background(), "q", bgeHits("a", "b", "c"), 10)
	if err != nil {
		t.Fatalf("Rerank: %v", err)
	}
	if want := []string{"c", "b", "a"}; !equalIDs(ids(got), want) {
		t.Errorf("reorder = %v, want %v", ids(got), want)
	}
}

// TestBgeReranker_AdditiveFallbackOnError: a 500 from the endpoint must degrade
// to the fused input order, NOT drop or error. This is the contract that keeps
// the P0 gate safe — a flaky reranker can never regress recall.
func TestBgeReranker_AdditiveFallbackOnError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	rr := &bgeReranker{endpoint: srv.URL, model: "test", client: srv.Client(), poolCap: bgeRerankPoolCap}
	in := bgeHits("a", "b", "c")
	got, err := rr.Rerank(context.Background(), "q", in, 10)
	if err != nil {
		t.Fatalf("Rerank should swallow endpoint error, got %v", err)
	}
	if want := []string{"a", "b", "c"}; !equalIDs(ids(got), want) {
		t.Errorf("fallback order = %v, want fused %v", ids(got), want)
	}
}

// TestBgeReranker_PoolCapPreservesTail: only the top poolCap candidates are
// scored; everything past the cap keeps its fused position appended after the
// reranked head.
func TestBgeReranker_PoolCapPreservesTail(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		var body bgeRerankRequest
		_ = json.NewDecoder(req.Body).Decode(&body)
		if len(body.Texts) != 2 {
			t.Errorf("scored %d texts, want only the 2 capped head candidates", len(body.Texts))
		}
		out := make([]bgeRerankResult, len(body.Texts))
		for i := range body.Texts {
			out[i] = bgeRerankResult{Index: i, Score: float64(len(body.Texts) - i)}
		}
		_ = json.NewEncoder(w).Encode(out)
	}))
	defer srv.Close()

	rr := &bgeReranker{endpoint: srv.URL, model: "test", client: srv.Client(), poolCap: 2}
	got, err := rr.Rerank(context.Background(), "q", bgeHits("a", "b", "c", "d"), 10)
	if err != nil {
		t.Fatalf("Rerank: %v", err)
	}
	// head [a,b] reranked to [b,a]; tail [c,d] preserved in fused order.
	if want := []string{"b", "a", "c", "d"}; !equalIDs(ids(got), want) {
		t.Errorf("pool-cap order = %v, want %v", ids(got), want)
	}
}

func equalIDs(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
