package team

// wiki_query_rerank.go — Phase 3 (P1) of OFFICE-201: cross-encoder rerank stage.
//
// A cross-encoder scores each (query, candidate) PAIR jointly — query and
// document attend to each other in one forward pass — which is a strictly
// stronger relevance signal than the P0 dense leg (a bi-encoder that embeds
// query and document independently and compares cosines). It is the canonical
// FINAL stage: cheap over the small fused candidate pool (topK ≈ 10), far too
// expensive over the whole corpus, so it runs LAST — after RRF has already
// narrowed the field down to the candidates worth the joint forward pass.
//
// Why a new seam and not embedding.Provider: that interface is a bi-encoder
// (Embed → vector). A cross-encoder returns a scalar relevance score for a
// (query, doc) pair and cannot be expressed as two independent embeddings. So
// P1 introduces its own Reranker interface; a real model — Cohere rerank-3,
// Voyage rerank-2, or a local bge-reranker — drops in behind it WITHOUT
// touching the retrieval routing.
//
// The default is a no-op passthrough. It lands ZERO new vendor surface and is a
// provable identity on the fused order, so the frozen P0 gate (recall@3 ≥ 0.90,
// nDCG@10 ≥ 0.95) holds exactly. Activating a real cross-encoder is a config
// flip plus the human's new-vendor decision — not a change to this routing.

import "context"

// Reranker rescores and reorders a candidate hit list against the query. The
// cross-encoder implementation scores each (query, hit.Snippet) pair jointly.
//
// Contract for any implementation:
//   - Order-deterministic on ties, so fused results stay stable across runs.
//   - Degrades to the input order on any model error (return hits, nil) — the
//     stage is ADDITIVE over RRF and must never cause a recall regression.
//   - Truncates to topK when topK > 0.
type Reranker interface {
	Rerank(ctx context.Context, query string, hits []SearchHit, topK int) ([]SearchHit, error)
	Name() string
}

// noopReranker is the default final stage: it returns the fused order unchanged
// (truncated to topK). This is the floor — it guarantees the P1 stage can never
// regress the P0 baseline, so the seam lands before a vendor model is chosen.
type noopReranker struct{}

// Name identifies this reranker in logs and the eval harness.
func (noopReranker) Name() string { return "noop-passthrough" }

// Rerank returns hits unchanged, capped at topK. Identity on order by design.
func (noopReranker) Rerank(_ context.Context, _ string, hits []SearchHit, topK int) ([]SearchHit, error) {
	if topK > 0 && len(hits) > topK {
		return hits[:topK], nil
	}
	return hits, nil
}

// applyRerank runs the final cross-encoder stage over an already-fused hit
// list. A nil reranker or an empty list is a no-op. Any reranker error (or an
// empty result) falls back to the input order — the stage is additive and must
// never drop below the fused baseline.
func applyRerank(ctx context.Context, rr Reranker, query string, hits []SearchHit, topK int) []SearchHit {
	if rr == nil || len(hits) == 0 {
		return hits
	}
	reranked, err := rr.Rerank(ctx, query, hits, topK)
	if err != nil || len(reranked) == 0 {
		return hits
	}
	return reranked
}
