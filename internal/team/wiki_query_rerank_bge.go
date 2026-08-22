package team

// wiki_query_rerank_bge.go — OFFICE-357: the real cross-encoder behind the P1
// Reranker seam (wiki_query_rerank.go). Drops bge-reranker-v2-m3 in WITHOUT
// touching retrieval routing — it satisfies the same interface noopReranker
// does, so WikiIndex.Search keeps calling applyRerank exactly as before.
//
// "Local" in the no-new-vendor sense: the weights run on our own host, served
// over an HTTP rerank endpoint (HuggingFace Text-Embeddings-Inference or an
// equivalent sidecar). Opt-in via BGE_RERANK_URL — exactly the shape the Voyage
// embedding leg uses for VOYAGE_API_KEY (internal/embedding/anthropic.go): no
// third-party API key, no new credential surface, no downstream sign-off. When
// the URL is unset the index stays on the noop passthrough and the frozen P0
// gate (recall@3 ≥ 0.90, nDCG@10 ≥ 0.95) holds exactly.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"
)

// bgeRerankPoolCap bounds the candidate pool scored by the cross-encoder. A
// cross-encoder is O(N) joint forward passes per query, so it must not run over
// an unbounded fused list. Capping to the top candidates from the RRF order
// keeps p95 latency bounded while still covering the rank-1 misses (the relevant
// fact already sits inside the fused top-K — see the OFFICE-201 baseline). 50
// per the OFFICE-357 guardrail.
const bgeRerankPoolCap = 50

const (
	defaultBgeRerankModel   = "bge-reranker-v2-m3"
	defaultBgeRerankTimeout = 5 * time.Second
)

// bgeReranker is the local bge-reranker-v2-m3 cross-encoder served over an HTTP
// rerank endpoint. It implements Reranker.
//
// Contract (Reranker): order-deterministic on ties (score desc, then original
// fused index asc), truncates to topK, and degrades to the INPUT order on any
// error — the stage stays strictly additive over RRF and can never cause a
// recall regression.
type bgeReranker struct {
	endpoint string // base URL, e.g. http://localhost:8080
	model    string
	client   *http.Client
	poolCap  int
}

// newBgeRerankerFromEnv returns a configured bgeReranker when BGE_RERANK_URL is
// set, or (nil, false) so the caller keeps the noop passthrough. Mirrors
// newVoyageProvider: an explicit env var is the activation switch, never an
// implicit default that would silently start shipping queries off-box.
func newBgeRerankerFromEnv() (*bgeReranker, bool) {
	endpoint := strings.TrimSpace(os.Getenv("BGE_RERANK_URL"))
	if endpoint == "" {
		return nil, false
	}
	model := strings.TrimSpace(os.Getenv("BGE_RERANK_MODEL"))
	if model == "" {
		model = defaultBgeRerankModel
	}
	return &bgeReranker{
		endpoint: strings.TrimRight(endpoint, "/"),
		model:    model,
		client:   &http.Client{Timeout: defaultBgeRerankTimeout},
		poolCap:  bgeRerankPoolCap,
	}, true
}

// Name identifies this reranker in logs and the eval harness.
func (r *bgeReranker) Name() string { return "bge-reranker-v2-m3" }

// bgeRerankRequest is the TEI /rerank request body. raw_scores keeps the model's
// logits rather than a normalized 0..1 squash — we only need the relative order.
type bgeRerankRequest struct {
	Query     string   `json:"query"`
	Texts     []string `json:"texts"`
	RawScores bool     `json:"raw_scores"`
}

// bgeRerankResult is one scored candidate. Index references the position in the
// request Texts slice; Score is the cross-encoder relevance logit.
type bgeRerankResult struct {
	Index int     `json:"index"`
	Score float64 `json:"score"`
}

// Rerank scores the top poolCap candidates jointly against the query, reorders
// them by score, splices the un-scored tail back in fused order, and truncates
// to topK. Any failure returns (hits, nil) so applyRerank falls back cleanly.
func (r *bgeReranker) Rerank(ctx context.Context, query string, hits []SearchHit, topK int) ([]SearchHit, error) {
	if len(hits) == 0 {
		return hits, nil
	}

	// Score only the fused top-poolCap; anything past the cap keeps its fused
	// position. Cross-encoders earn their cost on the head of the list, which is
	// where the rank-1 contention lives.
	poolN := r.poolCap
	if poolN <= 0 || poolN > len(hits) {
		poolN = len(hits)
	}
	pool := hits[:poolN]
	tail := hits[poolN:]

	texts := make([]string, len(pool))
	for i, h := range pool {
		texts[i] = h.Snippet
	}

	scores, err := r.score(ctx, query, texts)
	if err != nil {
		// Additive contract: any model/transport error degrades to fused order.
		return hits, nil
	}

	// Reorder the pool by descending score; break ties by the original fused
	// index so the result is deterministic across runs.
	order := make([]int, len(pool))
	for i := range order {
		order[i] = i
	}
	scoreByIdx := make([]float64, len(pool))
	for _, s := range scores {
		if s.Index >= 0 && s.Index < len(pool) {
			scoreByIdx[s.Index] = s.Score
		}
	}
	sort.SliceStable(order, func(a, b int) bool {
		ia, ib := order[a], order[b]
		if scoreByIdx[ia] != scoreByIdx[ib] {
			return scoreByIdx[ia] > scoreByIdx[ib]
		}
		return ia < ib
	})

	reranked := make([]SearchHit, 0, len(hits))
	for _, idx := range order {
		reranked = append(reranked, pool[idx])
	}
	reranked = append(reranked, tail...)

	if topK > 0 && len(reranked) > topK {
		reranked = reranked[:topK]
	}
	return reranked, nil
}

// score posts the (query, texts) batch to the TEI /rerank endpoint and returns
// the per-candidate relevance scores.
func (r *bgeReranker) score(ctx context.Context, query string, texts []string) ([]bgeRerankResult, error) {
	body, err := json.Marshal(bgeRerankRequest{Query: query, Texts: texts, RawScores: true})
	if err != nil {
		return nil, fmt.Errorf("bge rerank marshal: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.endpoint+"/rerank", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("bge rerank request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := r.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("bge rerank do: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("bge rerank status %d", resp.StatusCode)
	}

	var out []bgeRerankResult
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("bge rerank decode: %w", err)
	}
	return out, nil
}
