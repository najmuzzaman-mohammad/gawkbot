package team

// wiki_query_rerank_cohere_test.go — OFFICE-464 verification layer.
//
// Mirrors the Voyage test structure (wiki_query_rerank_voyage_test.go) for the
// Cohere rerank-3 client: wire format, score ordering, topK truncation, and
// fallback on every failure mode. Live recall delta against the 32-query labeled
// set requires COHERE_API_KEY + network egress — absent here per task brief.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCohereReranker_ReordersByScore(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Errorf("auth header = %q, want Bearer test-key", got)
		}
		var req cohereRerankRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if req.Model != "rerank-v3.5" {
			t.Errorf("model = %q, want rerank-v3.5", req.Model)
		}
		if len(req.Documents) != 3 {
			t.Errorf("documents len = %d, want 3", len(req.Documents))
		}
		if req.ReturnDocuments {
			t.Error("return_documents should be false — we hold the docs")
		}
		_ = json.NewEncoder(w).Encode(cohereRerankResponse{
			Results: []struct {
				Index          int     `json:"index"`
				RelevanceScore float64 `json:"relevance_score"`
			}{
				{Index: 2, RelevanceScore: 0.90},
				{Index: 1, RelevanceScore: 0.50},
				{Index: 0, RelevanceScore: 0.10},
			},
		})
	}))
	defer srv.Close()

	rr := &cohereReranker{apiKey: "test-key", baseURL: srv.URL, model: "rerank-v3.5", httpClient: srv.Client()}
	hits := []SearchHit{
		{FactID: "a", Snippet: "alpha"},
		{FactID: "b", Snippet: "bravo"},
		{FactID: "c", Snippet: "charlie"},
	}
	got, err := rr.Rerank(context.Background(), "q", hits, 0)
	if err != nil {
		t.Fatalf("Rerank: %v", err)
	}
	wantOrder := []string{"c", "b", "a"}
	for i, w := range wantOrder {
		if got[i].FactID != w {
			t.Errorf("position %d = %q, want %q", i, got[i].FactID, w)
		}
	}
	if got[0].Score != 0.90 {
		t.Errorf("top score = %v, want 0.90 (cross-encoder score surfaced)", got[0].Score)
	}
	if rr.Name() != "cohere-rerank-v3.5" {
		t.Errorf("Name = %q, want cohere-rerank-v3.5", rr.Name())
	}
}

func TestCohereReranker_TruncatesToTopK(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(cohereRerankResponse{
			Results: []struct {
				Index          int     `json:"index"`
				RelevanceScore float64 `json:"relevance_score"`
			}{
				{Index: 1, RelevanceScore: 0.9},
				{Index: 2, RelevanceScore: 0.5},
				{Index: 0, RelevanceScore: 0.2},
			},
		})
	}))
	defer srv.Close()

	rr := &cohereReranker{apiKey: "k", baseURL: srv.URL, model: "rerank-v3.5", httpClient: srv.Client()}
	hits := []SearchHit{{FactID: "a", Snippet: "x"}, {FactID: "b", Snippet: "y"}, {FactID: "c", Snippet: "z"}}
	got, err := rr.Rerank(context.Background(), "q", hits, 2)
	if err != nil {
		t.Fatalf("Rerank: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2 (topK truncation)", len(got))
	}
	if got[0].FactID != "b" || got[1].FactID != "c" {
		t.Errorf("got %s,%s want b,c", got[0].FactID, got[1].FactID)
	}
}

func TestCohereReranker_FallsBackOnFailure(t *testing.T) {
	hits := []SearchHit{{FactID: "a", Snippet: "x"}, {FactID: "b", Snippet: "y"}}

	cases := []struct {
		name    string
		handler http.HandlerFunc
	}{
		{"non-2xx", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusUnauthorized) }},
		{"empty-results", func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewEncoder(w).Encode(cohereRerankResponse{})
		}},
		{"bad-json", func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("{not json")) }},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			srv := httptest.NewServer(c.handler)
			defer srv.Close()
			rr := &cohereReranker{apiKey: "k", baseURL: srv.URL, model: "rerank-v3.5", httpClient: srv.Client()}
			got, err := rr.Rerank(context.Background(), "q", hits, 0)
			if err == nil {
				t.Errorf("%s: expected error so applyRerank falls back", c.name)
			}
			if len(got) != len(hits) || got[0].FactID != "a" || got[1].FactID != "b" {
				t.Errorf("%s: hits mutated on failure; want fused order preserved", c.name)
			}
		})
	}
}

func TestNewCohereReranker_NilWithoutKey(t *testing.T) {
	t.Setenv("COHERE_API_KEY", "")
	if r := newCohereReranker(); r != nil {
		t.Errorf("newCohereReranker = %v, want nil without key (→ noop passthrough)", r)
	}
	t.Setenv("WUPHF_RERANK", "cohere")
	if r := rerankerFromEnv(); r != nil {
		t.Errorf("rerankerFromEnv = %v, want nil without key even when flag is on", r)
	}
}

func TestRerankerFromEnv_CohereDispatch(t *testing.T) {
	t.Setenv("COHERE_API_KEY", "test-cohere-key")
	for _, flag := range []string{"cohere", "cohere-rerank-3", "rerank-3", "COHERE"} {
		t.Setenv("WUPHF_RERANK", flag)
		r := rerankerFromEnv()
		if r == nil {
			t.Errorf("WUPHF_RERANK=%q: got nil, want cohereReranker", flag)
			continue
		}
		if _, ok := r.(*cohereReranker); !ok {
			t.Errorf("WUPHF_RERANK=%q: got %T, want *cohereReranker", flag, r)
		}
	}
}
