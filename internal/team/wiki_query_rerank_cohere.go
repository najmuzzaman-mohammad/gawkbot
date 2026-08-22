package team

// wiki_query_rerank_cohere.go — OFFICE-464: swap the P1 cross-encoder from
// Voyage rerank-2 to Cohere rerank-3 behind the existing Reranker seam.
//
// Human decision 2026-06-26: pivot to Cohere rerank-3. Activate by setting
// WUPHF_RERANK=cohere (or =cohere-rerank-3) AND COHERE_API_KEY. If the key is
// absent the factory returns nil and the no-op passthrough stays active — the
// stage remains ADDITIVE and never causes a recall regression.
//
// Contract (Reranker interface, wiki_query_rerank.go):
//   - Joint (query, hit.Snippet) scoring via POST /v2/rerank over the small
//     fused pool — cheap because RRF already narrowed the field.
//   - ADDITIVE over RRF: any model error, empty key, or empty result returns
//     (hits, err) so applyRerank falls back to the fused order. The stage can
//     never regress the frozen P0 baseline (recall@3 ≥ 0.90, nDCG@10 ≥ 0.95).
//   - Order-deterministic on ties: equal relevance_score keeps the input order,
//     so fused results stay stable across runs.
//   - Truncates to topK when topK > 0.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	// defaultCohereRerankModel is the CEO-approved pick (rerank-3 family).
	// Override with WUPHF_RERANK_MODEL to switch variants without a code change.
	defaultCohereRerankModel = "rerank-v3.5"
	// cohereRerankPath is appended to the Cohere base URL.
	cohereRerankPath = "/v2/rerank"
	// defaultCohereRerankBaseURL is the Cohere v2 API host.
	defaultCohereRerankBaseURL = "https://api.cohere.com"
	// defaultCohereRerankTimeout bounds the single rerank round-trip.
	defaultCohereRerankTimeout = 10 * time.Second
)

// cohereRerankTimeoutFromEnv reads WUPHF_RERANK_TIMEOUT (whole seconds).
// Falls back to defaultCohereRerankTimeout for unset, non-numeric, or
// non-positive values.
func cohereRerankTimeoutFromEnv() time.Duration {
	raw := strings.TrimSpace(os.Getenv("WUPHF_RERANK_TIMEOUT"))
	if raw == "" {
		return defaultCohereRerankTimeout
	}
	secs, err := strconv.Atoi(raw)
	if err != nil || secs <= 0 {
		return defaultCohereRerankTimeout
	}
	return time.Duration(secs) * time.Second
}

// cohereReranker is the cross-encoder implementation of Reranker backed by
// Cohere's /v2/rerank endpoint. It reorders fused hits by joint relevance scores.
type cohereReranker struct {
	apiKey     string
	baseURL    string
	model      string
	httpClient *http.Client
}

// newCohereReranker returns a Cohere-backed Reranker when COHERE_API_KEY is set,
// or nil when the key is absent. A nil Reranker passed to WithReranker leaves the
// index on the no-op passthrough — activation is purely "key present + flag set".
func newCohereReranker() Reranker {
	key := strings.TrimSpace(os.Getenv("COHERE_API_KEY"))
	if key == "" {
		return nil
	}

	baseURL := strings.TrimSpace(os.Getenv("COHERE_BASE_URL"))
	if baseURL == "" {
		baseURL = defaultCohereRerankBaseURL
	}

	model := strings.TrimSpace(os.Getenv("WUPHF_RERANK_MODEL"))
	if model == "" {
		model = defaultCohereRerankModel
	}

	timeout := cohereRerankTimeoutFromEnv()

	return &cohereReranker{
		apiKey:     key,
		baseURL:    baseURL,
		model:      model,
		httpClient: &http.Client{Timeout: timeout},
	}
}

// Name identifies this reranker in logs and the eval harness.
func (r *cohereReranker) Name() string { return "cohere-" + r.model }

// cohereRerankRequest is the wire format for POST /v2/rerank.
// return_documents=false: we hold the documents and only need scores + indices.
type cohereRerankRequest struct {
	Query           string   `json:"query"`
	Documents       []string `json:"documents"`
	Model           string   `json:"model"`
	TopN            int      `json:"top_n,omitempty"`
	ReturnDocuments bool     `json:"return_documents"`
}

// cohereRerankResponse mirrors the Cohere /v2/rerank response shape.
// results[i].index points back into the request's documents slice.
type cohereRerankResponse struct {
	Results []struct {
		Index          int     `json:"index"`
		RelevanceScore float64 `json:"relevance_score"`
	} `json:"results"`
}

// Rerank scores each (query, hit.Snippet) pair jointly via Cohere and returns
// the hits reordered by relevance, truncated to topK. On ANY failure it returns
// (hits, err) so applyRerank keeps the fused order — additive, never regresses.
func (r *cohereReranker) Rerank(ctx context.Context, query string, hits []SearchHit, topK int) ([]SearchHit, error) {
	if len(hits) == 0 {
		return hits, nil
	}

	docs := make([]string, len(hits))
	for i, h := range hits {
		docs[i] = h.Snippet
	}

	reqBody := cohereRerankRequest{
		Query:           query,
		Documents:       docs,
		Model:           r.model,
		ReturnDocuments: false,
	}
	if topK > 0 && topK < len(hits) {
		reqBody.TopN = topK
	}

	body, err := json.Marshal(reqBody)
	if err != nil {
		return hits, fmt.Errorf("rerank: cohere: marshal: %w", err)
	}

	endpoint := strings.TrimRight(r.baseURL, "/") + cohereRerankPath
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return hits, fmt.Errorf("rerank: cohere: build request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+r.apiKey)

	resp, err := r.httpClient.Do(httpReq)
	if err != nil {
		return hits, fmt.Errorf("rerank: cohere: http: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode/100 != 2 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return hits, fmt.Errorf("rerank: cohere: status %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}

	var parsed cohereRerankResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return hits, fmt.Errorf("rerank: cohere: decode: %w", err)
	}
	if len(parsed.Results) == 0 {
		return hits, fmt.Errorf("rerank: cohere: empty results")
	}

	return reorderByCohereScores(hits, parsed, topK), nil
}

// reorderByCohereScores applies the returned (index, relevance_score) pairs to
// the input hits. Deterministic on ties (stable on original fused order), skips
// out-of-range indices defensively, truncates to topK.
func reorderByCohereScores(hits []SearchHit, resp cohereRerankResponse, topK int) []SearchHit {
	type scored struct {
		hit   SearchHit
		score float64
		orig  int
	}
	ranked := make([]scored, 0, len(resp.Results))
	for _, d := range resp.Results {
		if d.Index < 0 || d.Index >= len(hits) {
			continue
		}
		h := hits[d.Index]
		h.Score = d.RelevanceScore
		ranked = append(ranked, scored{hit: h, score: d.RelevanceScore, orig: d.Index})
	}
	if len(ranked) == 0 {
		return hits
	}

	sort.SliceStable(ranked, func(i, j int) bool {
		if ranked[i].score != ranked[j].score {
			return ranked[i].score > ranked[j].score
		}
		return ranked[i].orig < ranked[j].orig
	})

	limit := len(ranked)
	if topK > 0 && topK < limit {
		limit = topK
	}
	out := make([]SearchHit, 0, limit)
	for i := 0; i < limit; i++ {
		out = append(out, ranked[i].hit)
	}
	return out
}
