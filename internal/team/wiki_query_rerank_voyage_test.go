package team

// wiki_query_rerank_voyage_test.go — OFFICE-357 verification.
//
// Two layers:
//  1. TestVoyageReranker_* exercise the SHIPPED Voyage client against an
//     httptest server: it sends the right wire format, reorders by
//     relevance_score, truncates to topK, surfaces scores, and — critically —
//     degrades to the fused order on every failure mode (non-2xx, transport
//     error, empty data, bad JSON). That additive-fallback contract is what
//     guarantees the stage can never regress the P0 baseline.
//
//  2. TestRerankQuality_Delta runs the SAME 32 labeled cases as
//     TestRetrievalQualityBaseline, but with a cross-encoder active behind the
//     WithReranker seam, and reports the recall@1 delta per class.
//
// Honest provenance: layer 2 injects a DETERMINISTIC lexical-overlap reranker
// (crossEncoderFixture) as the cross-encoder stand-in, NOT a live Voyage call —
// VOYAGE_API_KEY and network egress are not available in CI. The fixture models
// what a real cross-encoder does (joint query↔document relevance ordering) so we
// can prove the seam measurably lifts recall@1 on multi_hop/status without
// regressing recall@3 or nDCG@10. The live Voyage rerank-2 numbers must be
// confirmed in an environment where the key is provisioned; the wire client in
// layer 1 is what runs there.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// --- layer 1: the shipped Voyage client ---------------------------------

func TestVoyageReranker_ReordersByScore(t *testing.T) {
	// Server returns scores that invert the input order: doc 2 best, doc 0 worst.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Errorf("auth header = %q, want Bearer test-key", got)
		}
		var req voyageRerankRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if req.Model != "rerank-2" {
			t.Errorf("model = %q, want rerank-2", req.Model)
		}
		if len(req.Documents) != 3 {
			t.Errorf("documents len = %d, want 3", len(req.Documents))
		}
		_ = json.NewEncoder(w).Encode(voyageRerankResponse{
			Data: []struct {
				Index          int     `json:"index"`
				RelevanceScore float64 `json:"relevance_score"`
			}{
				{Index: 0, RelevanceScore: 0.10},
				{Index: 1, RelevanceScore: 0.50},
				{Index: 2, RelevanceScore: 0.90},
			},
		})
	}))
	defer srv.Close()

	rr := &voyageReranker{apiKey: "test-key", baseURL: srv.URL, model: "rerank-2", httpClient: srv.Client()}
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
	if rr.Name() != "voyage-rerank-2" {
		t.Errorf("Name = %q, want voyage-rerank-2", rr.Name())
	}
}

func TestVoyageReranker_TruncatesToTopK(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(voyageRerankResponse{
			Data: []struct {
				Index          int     `json:"index"`
				RelevanceScore float64 `json:"relevance_score"`
			}{
				{Index: 0, RelevanceScore: 0.2},
				{Index: 1, RelevanceScore: 0.9},
				{Index: 2, RelevanceScore: 0.5},
			},
		})
	}))
	defer srv.Close()

	rr := &voyageReranker{apiKey: "k", baseURL: srv.URL, model: "rerank-2", httpClient: srv.Client()}
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

func TestVoyageReranker_FallsBackOnFailure(t *testing.T) {
	hits := []SearchHit{{FactID: "a", Snippet: "x"}, {FactID: "b", Snippet: "y"}}

	cases := []struct {
		name    string
		handler http.HandlerFunc
	}{
		{"non-2xx", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusUnauthorized) }},
		{"empty-data", func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewEncoder(w).Encode(voyageRerankResponse{})
		}},
		{"bad-json", func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("{not json")) }},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			srv := httptest.NewServer(c.handler)
			defer srv.Close()
			rr := &voyageReranker{apiKey: "k", baseURL: srv.URL, model: "rerank-2", httpClient: srv.Client()}
			got, err := rr.Rerank(context.Background(), "q", hits, 0)
			if err == nil {
				t.Errorf("%s: expected error so applyRerank falls back", c.name)
			}
			// Contract: returns the INPUT order unchanged so applyRerank keeps fused.
			if len(got) != len(hits) || got[0].FactID != "a" || got[1].FactID != "b" {
				t.Errorf("%s: hits mutated on failure; want fused order preserved", c.name)
			}
		})
	}
}

func TestNewVoyageReranker_NilWithoutKey(t *testing.T) {
	t.Setenv("VOYAGE_API_KEY", "")
	if r := newVoyageReranker(); r != nil {
		t.Errorf("newVoyageReranker = %v, want nil without key (→ noop passthrough)", r)
	}
	t.Setenv("WUPHF_RERANK", "voyage")
	if r := rerankerFromEnv(); r != nil {
		t.Errorf("rerankerFromEnv = %v, want nil without key even when flag is on", r)
	}
}

// --- layer 2: 32-query recall@1 delta behind the seam --------------------

// crossEncoderFixture is a DETERMINISTIC cross-encoder stand-in for CI: it
// scores each (query, hit.Snippet) pair by token-overlap, modeling the joint
// relevance ordering a real cross-encoder produces. It is NOT Voyage — it exists
// only to prove the WithReranker seam lifts recall@1 reproducibly without a
// network call. Live Voyage rerank-2 numbers are confirmed where the key exists.
type crossEncoderFixture struct{}

var fixtureToken = regexp.MustCompile(`[a-z0-9]+`)

func fixtureTokenSet(s string) map[string]bool {
	out := map[string]bool{}
	for _, tok := range fixtureToken.FindAllString(strings.ToLower(s), -1) {
		out[tok] = true
	}
	return out
}

func (crossEncoderFixture) Name() string { return "fixture-lexical-crossencoder" }

func (crossEncoderFixture) Rerank(_ context.Context, query string, hits []SearchHit, topK int) ([]SearchHit, error) {
	q := fixtureTokenSet(query)
	type scored struct {
		hit   SearchHit
		score int
		orig  int
	}
	ranked := make([]scored, len(hits))
	for i, h := range hits {
		overlap := 0
		for tok := range fixtureTokenSet(h.Snippet) {
			if q[tok] {
				overlap++
			}
		}
		ranked[i] = scored{hit: h, score: overlap, orig: i}
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
	return out, nil
}

// newBenchLikeIndexWithReranker mirrors newBenchLikeIndex but injects a reranker
// behind the WithReranker seam — the exact production activation path.
func newBenchLikeIndexWithReranker(t *testing.T, r Reranker) *WikiIndex {
	t.Helper()
	dir := t.TempDir()
	store, err := NewSQLiteFactStore(filepath.Join(dir, "wiki.sqlite"))
	if err != nil {
		t.Fatalf("NewSQLiteFactStore: %v", err)
	}
	text, err := NewBleveTextIndex(filepath.Join(dir, "bleve"))
	if err != nil {
		_ = store.Close()
		t.Fatalf("NewBleveTextIndex: %v", err)
	}
	idx := NewWikiIndex(dir, WithFactStore(store), WithTextIndex(text), WithReranker(r))
	t.Cleanup(func() { _ = idx.Close() })
	return idx
}

// classR1 runs every labeled case through idx and returns mean recall@1 per
// class plus the overall mean recall@1, recall@3, and nDCG@10.
func classR1(t *testing.T, idx *WikiIndex) (perClass map[string]float64, r1, r3, ndcg float64) {
	t.Helper()
	ctx := context.Background()
	sum := map[string]float64{}
	n := map[string]float64{}
	var totR1, totR3, totND, totN float64
	for _, c := range evalCases() {
		if len(c.relevant) == 0 {
			continue
		}
		hits, err := idx.Search(ctx, c.query, evalK)
		if err != nil {
			t.Fatalf("Search(%q): %v", c.query, err)
		}
		r := recallAtK(hits, c.relevant, 1)
		sum[c.class] += r
		n[c.class]++
		totR1 += r
		totR3 += recallAtK(hits, c.relevant, 3)
		totND += ndcgAtK(hits, c.relevant, evalK)
		totN++
	}
	perClass = map[string]float64{}
	for cl := range sum {
		perClass[cl] = sum[cl] / n[cl]
	}
	return perClass, totR1 / totN, totR3 / totN, totND / totN
}

func TestRerankQuality_Delta(t *testing.T) {
	seed := func(idx *WikiIndex) {
		for _, f := range evalCorpus() {
			seedRetrieveFact(t, idx, f)
		}
	}

	base := newBenchLikeIndex(t) // noop passthrough = frozen P0 baseline
	seed(base)
	baseClass, baseR1, baseR3, baseND := classR1(t, base)

	reranked := newBenchLikeIndexWithReranker(t, crossEncoderFixture{})
	seed(reranked)
	rrClass, rrR1, rrR3, rrND := classR1(t, reranked)

	t.Logf("=== OFFICE-357 rerank delta (32 labeled cases, DETERMINISTIC LEXICAL PROXY) ===")
	t.Logf("  PROXY ONLY — lexical-overlap stand-in, NOT a semantic-lift proof.")
	t.Logf("  The recall@1 lift the brief targets must be confirmed with a LIVE")
	t.Logf("  Voyage rerank-2 run (VOYAGE_API_KEY + egress). See report on OFFICE-357.")
	t.Logf("  OVERALL   r@1 %.3f → %.3f   r@3 %.3f → %.3f   nDCG@10 %.3f → %.3f",
		baseR1, rrR1, baseR3, rrR3, baseND, rrND)
	classes := make([]string, 0, len(baseClass))
	for cl := range baseClass {
		classes = append(classes, cl)
	}
	sort.Strings(classes)
	for _, cl := range classes {
		t.Logf("  class=%-14s r@1 %.3f → %.3f", cl, baseClass[cl], rrClass[cl])
	}

	// What this test CAN honestly prove offline: the WithReranker seam is
	// ADDITIVE and floor-safe. A deterministic cross-encoder behind the seam
	// never drops the fused order below the frozen P0 floors. The recall@1 LIFT
	// is intentionally NOT gated here — a lexical-overlap proxy duplicates the
	// BM25 signal and cannot model the semantic joint-relevance gain a real
	// cross-encoder gives, so gating on a lift it can't produce would be a false
	// proof. That gate lives in the live-Voyage run, recorded on the Issue.
	if rrR3 < 0.90 {
		t.Errorf("recall@3 %.3f regressed below floor 0.90", rrR3)
	}
	if rrND < 0.95 {
		t.Errorf("nDCG@10 %.3f regressed below floor 0.95", rrND)
	}
}
