package team

// wiki_query_rerank_voyage.go — OFFICE-357: the real cross-encoder behind the
// P1 Reranker seam. Replaces the no-op passthrough with Voyage rerank-2.
//
// Vendor choice (CEO-approved 2026-06-25): Voyage rerank-2 reuses the
// VOYAGE_API_KEY credential and the api.voyageai.com host already wired for
// embeddings in internal/embedding/anthropic.go — a true drop-in behind the
// existing Reranker interface with ZERO new vendor surface. Cohere rerank-3
// would have meant a net-new credential + sign-off for no measured gain on our
// 32-query set.
//
// Contract (Reranker interface, wiki_query_rerank.go):
//   - Joint (query, hit.Snippet) scoring in one /v1/rerank call over the small
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
	// defaultVoyageRerankModel is the CEO-approved pick. Override with
	// WUPHF_RERANK_MODEL to take rerank-2.5 (newer variant) without a code change.
	defaultVoyageRerankModel = "rerank-2"
	// voyageRerankPath is appended to the Voyage host. Same host + key as the
	// embedding path (api.voyageai.com), so no new credential surface.
	voyageRerankPath = "/v1/rerank"
	// defaultVoyageRerankBaseURL mirrors the embedding leg's host
	// (internal/embedding/anthropic.go) so the same VOYAGE_API_KEY reaches the
	// same backend. Declared locally because that const is unexported in the
	// embedding package — this stage shares the host, not the symbol.
	defaultVoyageRerankBaseURL = "https://api.voyageai.com"
	// defaultVoyageRerankTimeout bounds the single rerank round-trip. One network
	// call per query over ~10 fused candidates; a slow call degrades to fused
	// order rather than stalling the lookup.
	defaultVoyageRerankTimeout = 10 * time.Second
)

// voyageRerankTimeoutFromEnv reads WUPHF_RERANK_TIMEOUT (whole seconds) so the
// single rerank round-trip can be tuned without a code change. Falls back to
// defaultVoyageRerankTimeout for unset, non-numeric, or non-positive values.
func voyageRerankTimeoutFromEnv() time.Duration {
	raw := strings.TrimSpace(os.Getenv("WUPHF_RERANK_TIMEOUT"))
	if raw == "" {
		return defaultVoyageRerankTimeout
	}
	secs, err := strconv.Atoi(raw)
	if err != nil || secs <= 0 {
		return defaultVoyageRerankTimeout
	}
	return time.Duration(secs) * time.Second
}

// voyageReranker is the cross-encoder implementation of Reranker. It posts the
// (query, candidate-snippets) pool to Voyage's /v1/rerank endpoint and reorders
// the fused hits by the returned relevance scores.
type voyageReranker struct {
	apiKey     string
	baseURL    string
	model      string
	httpClient *http.Client
}

// newVoyageReranker returns a Voyage-backed Reranker when VOYAGE_API_KEY is set,
// or nil when the key is absent. A nil Reranker passed to WithReranker leaves the
// index on the no-op passthrough — so activation is purely "is the key present
// and the flag set", with a safe fallback either way.
func newVoyageReranker() Reranker {
	key := strings.TrimSpace(os.Getenv("VOYAGE_API_KEY"))
	if key == "" {
		return nil
	}

	// Reuse the embedding path's host override so a single VOYAGE_BASE_URL knob
	// points both embeddings and rerank at the same backend (e.g. a proxy).
	baseURL := strings.TrimSpace(os.Getenv("VOYAGE_BASE_URL"))
	if baseURL == "" {
		baseURL = defaultVoyageRerankBaseURL
	}

	model := strings.TrimSpace(os.Getenv("WUPHF_RERANK_MODEL"))
	if model == "" {
		model = defaultVoyageRerankModel
	}

	timeout := voyageRerankTimeoutFromEnv()

	return &voyageReranker{
		apiKey:     key,
		baseURL:    baseURL,
		model:      model,
		httpClient: &http.Client{Timeout: timeout},
	}
}

// rerankerFromEnv resolves the final rerank stage from configuration. It is the
// single config flip the brief calls for: WUPHF_RERANK selects the provider, and
// the credential must also be present. It returns nil — keeping the no-op
// passthrough — for any of: flag unset, unknown provider, or missing key.
//
// Supported providers:
//   - WUPHF_RERANK=cohere (or =cohere-rerank-3, =rerank-3): Cohere rerank-3 via
//     COHERE_API_KEY (CEO-approved 2026-06-26, replaces Voyage rerank-2)
//   - WUPHF_RERANK=voyage (or =voyage-rerank-2, =rerank-2): Voyage rerank-2 via
//     VOYAGE_API_KEY (retained as a fallback path)
func rerankerFromEnv() Reranker {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("WUPHF_RERANK"))) {
	case "cohere", "cohere-rerank-3", "rerank-3":
		return newCohereReranker() // nil when COHERE_API_KEY is absent → noop
	case "voyage", "voyage-rerank-2", "rerank-2":
		return newVoyageReranker() // nil when VOYAGE_API_KEY is absent → noop
	default:
		return nil
	}
}

// Name identifies this reranker in logs and the eval harness.
func (r *voyageReranker) Name() string { return "voyage-" + r.model }

// voyageRerankRequest is the wire format for POST /v1/rerank. We never ask the
// server to echo documents back (return_documents=false) — we already hold them
// and only need the scores + indices to reorder our own hits.
type voyageRerankRequest struct {
	Query           string   `json:"query"`
	Documents       []string `json:"documents"`
	Model           string   `json:"model"`
	ReturnDocuments bool     `json:"return_documents"`
	TopK            int      `json:"top_k,omitempty"`
}

// voyageRerankResponse mirrors the Voyage rerank response. data[i].index points
// back into the request's documents slice; relevance_score is the cross-encoder
// score. The API may return data pre-sorted by score, but we re-sort defensively
// so a compat backend that returns input order can't silently disable reranking.
type voyageRerankResponse struct {
	Data []struct {
		Index          int     `json:"index"`
		RelevanceScore float64 `json:"relevance_score"`
	} `json:"data"`
	Model string `json:"model"`
}

// Rerank scores each (query, hit.Snippet) pair jointly via Voyage and returns
// the hits reordered by relevance, truncated to topK. On ANY failure it returns
// (hits, err) so applyRerank keeps the fused order — the stage is additive and
// must never drop below the RRF baseline.
func (r *voyageReranker) Rerank(ctx context.Context, query string, hits []SearchHit, topK int) ([]SearchHit, error) {
	if len(hits) == 0 {
		return hits, nil
	}

	docs := make([]string, len(hits))
	for i, h := range hits {
		docs[i] = h.Snippet
	}

	reqBody := voyageRerankRequest{
		Query:           query,
		Documents:       docs,
		Model:           r.model,
		ReturnDocuments: false,
	}
	if topK > 0 && topK < len(hits) {
		reqBody.TopK = topK
	}

	body, err := json.Marshal(reqBody)
	if err != nil {
		return hits, fmt.Errorf("rerank: voyage: marshal: %w", err)
	}

	endpoint := strings.TrimRight(r.baseURL, "/") + voyageRerankPath
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return hits, fmt.Errorf("rerank: voyage: build request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+r.apiKey)

	resp, err := r.httpClient.Do(httpReq)
	if err != nil {
		return hits, fmt.Errorf("rerank: voyage: http: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode/100 != 2 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return hits, fmt.Errorf("rerank: voyage: status %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}

	var parsed voyageRerankResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return hits, fmt.Errorf("rerank: voyage: decode: %w", err)
	}
	if len(parsed.Data) == 0 {
		return hits, fmt.Errorf("rerank: voyage: empty data")
	}

	return reorderByVoyageScores(hits, parsed, topK), nil
}

// reorderByVoyageScores applies the returned (index, score) pairs to the input
// hits. It is deterministic on ties (stable on the original fused order), skips
// out-of-range indices defensively, and truncates to topK. Any hit the API did
// not score (shouldn't happen with return_documents=false) is dropped — the
// caller's applyRerank fallback covers the empty-result case.
func reorderByVoyageScores(hits []SearchHit, resp voyageRerankResponse, topK int) []SearchHit {
	type scored struct {
		hit   SearchHit
		score float64
		orig  int // original fused position — the stable tie-breaker
	}
	ranked := make([]scored, 0, len(resp.Data))
	for _, d := range resp.Data {
		if d.Index < 0 || d.Index >= len(hits) {
			continue // ignore an index the server should never send
		}
		h := hits[d.Index]
		h.Score = d.RelevanceScore // surface the cross-encoder score to callers
		ranked = append(ranked, scored{hit: h, score: d.RelevanceScore, orig: d.Index})
	}
	if len(ranked) == 0 {
		return hits
	}

	sort.SliceStable(ranked, func(i, j int) bool {
		if ranked[i].score != ranked[j].score {
			return ranked[i].score > ranked[j].score // higher relevance first
		}
		return ranked[i].orig < ranked[j].orig // tie → keep fused order
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
