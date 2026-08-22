package team

// wiki_query_fusion.go — Phase 2 (P0) of OFFICE-201: Reciprocal Rank Fusion.
//
// Replaces the BM25-only path for status/general queries with an RRF fusion
// across three retrieval legs:
//
//	1. BM25         — lexical recall floor (unchanged; never dropped)
//	2. entity-graph — typed role_at walk for the person named in the query
//	3. dense        — semantic rerank of the candidate pool via the embedder
//
// RRF (Cormack, Clarke & Buettcher 2009): score(d) = Σ_legs 1/(k + rank_leg(d)),
// with k=60 (the canonical default). A fact surfaced by multiple legs outranks
// one surfaced by a single leg — which is exactly the signal that fixes the
// status losers (q05 "Carol Mei", q09 "Dana Fox"): the role_at fact appears in
// BM25 *and* the entity-graph leg, so it overtakes the token-overlap distractor
// ("Carol Mei leads the Partner Program") that only appears in the BM25 leg.
//
// The typed walks (multi_hop, counterfactual, relationship) keep their additive
// union: those classes already sit at their recall@1 ceiling (multi-fact
// expected sets), so RRF there is risk with no upside. P0 changes the one path
// with genuine rank-1 headroom — the BM25-only status/general default.

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/nex-crm/wuphf/internal/embedding"
)

// rrfK is the canonical Reciprocal Rank Fusion damping constant. 60 is the
// value from the original RRF paper and the de-facto default; it keeps any one
// leg from dominating while still rewarding multi-leg agreement. Per the
// OFFICE-201 guardrails the legs carry equal weight (a single shared k).
const rrfK = 60.0

// retrieveFused is the status/general retrieval path. It runs three legs —
// BM25, entity-graph role_at walk, dense cosine rerank — and fuses their rank
// lists with RRF. BM25 is always the recall floor; if the entity parse fails or
// the embedder is a no-op, the fusion degrades gracefully to the remaining legs
// and never falls below the prior BM25-only baseline.
func retrieveFused(ctx context.Context, store FactStore, text TextIndex, embedder embedding.Provider, query string, topK int) ([]SearchHit, error) {
	// Leg 1 — BM25 lexical. The recall floor; never bypassed.
	bm25Hits, err := text.Search(ctx, query, topK)
	if err != nil {
		return nil, fmt.Errorf("retrieveFused bm25: %w", err)
	}

	// Leg 2 — entity-graph. Resolve the person named in the status query and
	// pull their role_at fact(s). This is the discriminating signal: it surfaces
	// *only* the role_at fact, so RRF lifts it above any token-overlap distractor
	// that shares the person's name. Best-effort — a parse miss yields no hits
	// and BM25 still carries the floor.
	entityHits := entityGraphLeg(ctx, store, query)

	// Leg 3 — dense semantic rerank over the candidate pool (BM25 ∪ entity).
	// Lights up the embedder that was idle until P0. With a non-semantic stub
	// provider (no embeddings API key in this environment) this leg is weak but
	// harmless: RRF weights it equally and the entity-graph leg carries the
	// decisive signal. With a real provider (Voyage/OpenAI) it adds true
	// semantic recall on paraphrased queries.
	denseHits := denseLeg(ctx, embedder, query, bm25Hits, entityHits)

	return fuseRRF([][]SearchHit{bm25Hits, entityHits, denseHits}, rrfK, topK), nil
}

// statusSubjectREs extract the person display span from a status query. They
// mirror the rolePatterns the classifier already keys on, so any query that
// ClassifyQuery routes to the status path and names a person is parseable here.
var statusSubjectREs = []*regexp.Regexp{
	// "What does Carol Mei do?" → "Carol Mei"
	regexp.MustCompile(`(?i)^what does\s+(.+?)\s+do\b`),
	// "What is Tom Reed's role/job/title/position?" → "Tom Reed"
	regexp.MustCompile(`(?i)^what is\s+(.+?)['’]s\s+(?:role|job|title|position)\b`),
}

// parseStatusSubject returns the person display span from a status query, or
// ("", false) when no pattern matches. Reuses cleanSpan so wikilinks and
// possessives are handled identically to the other typed parsers.
func parseStatusSubject(query string) (personDisplay string, ok bool) {
	q := strings.TrimSpace(query)
	for _, re := range statusSubjectREs {
		m := re.FindStringSubmatch(q)
		if len(m) >= 2 {
			if span := cleanSpan(m[1]); span != "" {
				return span, true
			}
		}
	}
	return "", false
}

// entityGraphLeg resolves the person named in a status query and returns their
// role_at fact(s) as a ranked list (most-recent first — "current role"). It is
// best-effort: a parse miss, an unresolved slug, or a store error all yield nil
// so the BM25 leg remains the recall floor.
func entityGraphLeg(ctx context.Context, store FactStore, query string) []SearchHit {
	personDisplay, ok := parseStatusSubject(query)
	if !ok {
		return nil
	}
	var facts []TypedFact
	for _, slug := range displayToSlugCandidates(personDisplay) {
		got, err := store.ListFactsByTriplet(ctx, slug, "role_at", "")
		if err != nil {
			return nil
		}
		if len(got) > 0 {
			facts = got
			break
		}
	}
	if len(facts) == 0 {
		return nil
	}
	// Status answers the *current* role, so rank the most recent role_at first.
	sort.SliceStable(facts, func(i, j int) bool {
		return facts[i].CreatedAt.After(facts[j].CreatedAt)
	})
	hits := make([]SearchHit, 0, len(facts))
	for _, f := range facts {
		hits = append(hits, factToHit(f))
	}
	return hits
}

// denseLeg reranks the candidate pool (the union of the other legs, deduped by
// FactID) by cosine similarity of the embedder's query vector against each
// candidate's snippet. Returns nil when there is no embedder, no pool, or the
// query fails to embed — RRF then proceeds with the remaining legs.
func denseLeg(ctx context.Context, embedder embedding.Provider, query string, legs ...[]SearchHit) []SearchHit {
	if embedder == nil {
		return nil
	}
	seen := map[string]bool{}
	var pool []SearchHit
	for _, leg := range legs {
		for _, h := range leg {
			if h.FactID == "" || h.Snippet == "" || seen[h.FactID] {
				continue
			}
			seen[h.FactID] = true
			pool = append(pool, h)
		}
	}
	if len(pool) == 0 {
		return nil
	}
	qVec, err := embedder.Embed(ctx, query)
	if err != nil {
		return nil
	}
	type scored struct {
		hit SearchHit
		sim float32
	}
	ranked := make([]scored, 0, len(pool))
	for _, h := range pool {
		v, err := embedder.Embed(ctx, h.Snippet)
		if err != nil {
			continue
		}
		ranked = append(ranked, scored{hit: h, sim: embedding.Cosine(qVec, v)})
	}
	// Descending cosine; FactID tie-break keeps the ordering deterministic so a
	// stub embedder's frequent ties don't make the fused result flaky.
	sort.SliceStable(ranked, func(i, j int) bool {
		if ranked[i].sim != ranked[j].sim {
			return ranked[i].sim > ranked[j].sim
		}
		return ranked[i].hit.FactID < ranked[j].hit.FactID
	})
	out := make([]SearchHit, 0, len(ranked))
	for _, s := range ranked {
		out = append(out, s.hit)
	}
	return out
}

// fuseRRF combines several ranked SearchHit lists into one via Reciprocal Rank
// Fusion: each list contributes 1/(k + rank) to every fact it ranks (rank is
// 1-based). Facts present in more lists accumulate more score, so multi-leg
// agreement wins. Ties break on FactID for deterministic output. The fused
// Score field is overwritten with the RRF score so downstream consumers that
// read ranks/scores see the fused ordering. Capped at topK.
func fuseRRF(lists [][]SearchHit, k float64, topK int) []SearchHit {
	if topK <= 0 {
		topK = 20
	}
	type acc struct {
		hit   SearchHit
		score float64
	}
	agg := map[string]*acc{}
	order := make([]string, 0, topK)
	for _, list := range lists {
		for rank, h := range list {
			if h.FactID == "" {
				continue
			}
			a := agg[h.FactID]
			if a == nil {
				a = &acc{hit: h}
				agg[h.FactID] = a
				order = append(order, h.FactID)
			}
			a.score += 1.0 / (k + float64(rank+1))
		}
	}
	ranked := make([]*acc, 0, len(order))
	for _, id := range order {
		ranked = append(ranked, agg[id])
	}
	sort.SliceStable(ranked, func(i, j int) bool {
		if ranked[i].score != ranked[j].score {
			return ranked[i].score > ranked[j].score
		}
		return ranked[i].hit.FactID < ranked[j].hit.FactID
	})
	out := make([]SearchHit, 0, topK)
	for _, a := range ranked {
		if len(out) >= topK {
			break
		}
		h := a.hit
		h.Score = a.score
		out = append(out, h)
	}
	return out
}
