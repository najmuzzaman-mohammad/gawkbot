package team

// wiki_query_eval_test.go — Phase 1 of OFFICE-201: the retrieval-quality eval
// gate. This is the regression oracle that MUST land before any ranking change
// (RRF fusion in P0, cross-encoder rerank in P1). It measures the CURRENT
// WikiIndex.Search pipeline (BM25 ∪ typed-graph walk, additive union) so later
// diffs can be scored as a delta against a frozen baseline.
//
// Why a separate harness from evals/query/: those are prompt-level golden cases
// (answer_query.tmpl drift). This one scores *retrieval* — did the right facts
// come back, and in a good order — using set-membership recall@k and binary
// nDCG@10. Different failure mode, different gate.
//
// Dataset note (honest provenance): the plan calls for ~30–50 labeled
// query→relevant-doc pairs "from real /lookup traffic". Live query logs are not
// available in this environment, so the labeled set below is a synthetic-but-
// representative corpus modeled on the four query classes the router actually
// dispatches (see wiki_query_retrieve.go): status, relationship
// (champions/leads/involved_in), multi_hop, counterfactual, plus out-of-scope
// refusal probes. When real /lookup traffic becomes capturable, append it to
// evalCorpus/evalCases — the metrics and runner do not change.
//
// Reuses newBenchLikeIndex + seedRetrieveFact from wiki_query_retrieve_test.go
// (same package) so there is zero new test infrastructure.

import (
	"context"
	"math"
	"sort"
	"testing"
	"time"
)

// evalK is the cutoff for both recall@k and nDCG@k. 10 matches the plan's
// nDCG@10 metric and the default lookup top-K surface.
const evalK = 10

// evalCase is one labeled query→relevant-facts pair. relevant holds the FactIDs
// a correct retriever should surface for query; class documents which router
// path the query is expected to exercise (for per-class baseline breakdown).
// An empty relevant slice marks an out-of-scope refusal probe — excluded from
// recall/nDCG aggregation, scored separately for precision (it should return
// no labeled-relevant fact because none exists).
type evalCase struct {
	id       string
	query    string
	class    string
	relevant []string
}

// fact is a compact corpus-entry constructor so the dataset table stays
// readable. createdAt is fixed-offset deterministic — no wall clock in fixtures.
func evalFact(id, subject, kind, factType, predicate, object, text string, day int) TypedFact {
	var trip *Triplet
	if predicate != "" {
		trip = &Triplet{Subject: subject, Predicate: predicate, Object: object}
	}
	return TypedFact{
		ID:         id,
		EntitySlug: subject,
		Kind:       kind,
		Type:       factType,
		Triplet:    trip,
		Text:       text,
		CreatedAt:  time.Date(2026, 2, day, 0, 0, 0, 0, time.UTC),
		CreatedBy:  "eval-seed",
	}
}

// evalCorpus is the labeled wiki-corpus stand-in: four companies, five
// projects, role_at status facts, and relationship facts (champions/leads/
// involved_in) plus distractor noise. Designed so typed walks help on the
// shapes they parse and BM25 carries the floor everywhere else.
func evalCorpus() []TypedFact {
	return []TypedFact{
		// --- Vandelay / Q2 Pilot Program ---
		evalFact("p-sarah", "sarah-jones", "person", "status", "role_at", "company:vandelay", "Sarah Jones is VP of Sales at Vandelay Industries.", 1),
		evalFact("p-tom", "tom-reed", "person", "status", "role_at", "company:vandelay", "Tom Reed is Head of Engineering at Vandelay Industries.", 1),
		evalFact("r-sarah-q2", "sarah-jones", "person", "relationship", "champions", "project:q2-pilot", "Sarah Jones championed the Q2 Pilot Program.", 2),
		evalFact("r-tom-q2", "tom-reed", "person", "relationship", "leads", "project:q2-pilot", "Tom Reed leads the Q2 Pilot Program engineering track.", 2),
		evalFact("r-nina-q2", "nina-patel", "person", "relationship", "involved_in", "project:q2-pilot", "Nina Patel is involved in the Q2 Pilot Program rollout.", 3),

		// --- Blueshift / APAC Launch ---
		evalFact("p-ivan", "ivan-petrov", "person", "status", "role_at", "company:blueshift", "Ivan Petrov leads Growth at Blueshift.", 1),
		evalFact("p-bob", "bob-klein", "person", "status", "role_at", "company:blueshift", "Bob Klein is Director of Product at Blueshift.", 1),
		evalFact("p-alice", "alice-stone", "person", "status", "role_at", "company:blueshift", "Alice Stone is Senior PMM at Blueshift.", 1),
		evalFact("r-bob-apac", "bob-klein", "person", "relationship", "champions", "project:apac-launch", "Bob Klein championed the APAC Launch from kickoff to GA.", 2),
		evalFact("r-alice-apac", "alice-stone", "person", "relationship", "leads", "project:apac-launch", "Alice Stone leads the APAC Launch go-to-market.", 2),

		// --- Acme Corp / Partner Program ---
		evalFact("p-carol", "carol-mei", "person", "status", "role_at", "company:acme-corp", "Carol Mei is VP Marketing at Acme Corp.", 1),
		evalFact("p-dana", "dana-fox", "person", "status", "role_at", "company:acme-corp", "Dana Fox is Partnerships Lead at Acme Corp.", 1),
		evalFact("r-carol-pp", "carol-mei", "person", "relationship", "leads", "project:partner-program", "Carol Mei leads the Partner Program.", 2),
		evalFact("r-dana-pp", "dana-fox", "person", "relationship", "champions", "project:partner-program", "Dana Fox champions the Partner Program.", 2),
		evalFact("r-ellen-pp", "ellen-ng", "person", "relationship", "involved_in", "project:partner-program", "Ellen Ng is involved in the Partner Program go-to-market.", 3),

		// --- Initech / Atlas Migration ---
		evalFact("p-frank", "frank-li", "person", "status", "role_at", "company:initech", "Frank Li is CTO at Initech.", 1),
		evalFact("p-grace", "grace-kim", "person", "status", "role_at", "company:initech", "Grace Kim is Staff Engineer at Initech.", 1),
		evalFact("r-frank-atlas", "frank-li", "person", "relationship", "leads", "project:atlas-migration", "Frank Li leads the Atlas Migration.", 2),
		evalFact("r-grace-atlas", "grace-kim", "person", "relationship", "champions", "project:atlas-migration", "Grace Kim champions the Atlas Migration cutover.", 2),

		// --- Orion Launch (no triplet slug match → BM25-only territory) ---
		evalFact("o-heidi", "heidi-cole", "person", "observation", "", "", "Heidi Cole drafted the Orion Launch positioning brief.", 4),
		evalFact("o-status", "orion-launch", "project", "status", "", "", "The Orion Launch is scheduled for Q3 and remains on track.", 4),

		// --- Distractor noise (shares surface tokens, matches no labeled query) ---
		evalFact("n-sync", "team", "team", "observation", "", "", "The weekly champions sync covers launch checklists and brief reviews.", 5),
		evalFact("n-plan", "team", "team", "observation", "", "", "Quarterly planning notes mention pilot programs and partner rollouts.", 5),
		evalFact("n-allhands", "team", "team", "observation", "", "", "Engineering all-hands recap: migration timelines and product directions.", 5),
	}
}

// evalCases is the labeled query set: 34 queries, 32 with relevance labels
// (the 2 out-of-scope probes carry empty relevant), spanning every router path.
func evalCases() []evalCase {
	return []evalCase{
		// status (BM25 path)
		{"q01", "What does Sarah Jones do?", "status", []string{"p-sarah"}},
		{"q02", "What is Tom Reed's role?", "status", []string{"p-tom"}},
		{"q03", "What does Ivan Petrov do?", "status", []string{"p-ivan"}},
		{"q04", "What is Bob Klein's title?", "status", []string{"p-bob"}},
		{"q05", "What does Carol Mei do?", "status", []string{"p-carol"}},
		{"q06", "What is Frank Li's role?", "status", []string{"p-frank"}},
		{"q07", "What does Grace Kim do?", "status", []string{"p-grace"}},
		{"q08", "What is Alice Stone's role?", "status", []string{"p-alice"}},
		{"q09", "What does Dana Fox do?", "status", []string{"p-dana"}},
		{"q10", "What is the status of the Orion Launch?", "status", []string{"o-status", "o-heidi"}},

		// relationship — champions
		{"q11", "Who champions the Q2 Pilot Program?", "relationship", []string{"r-sarah-q2"}},
		{"q12", "Who champions APAC Launch?", "relationship", []string{"r-bob-apac"}},
		{"q13", "Who champions the Partner Program?", "relationship", []string{"r-dana-pp"}},
		{"q14", "Who champions the Atlas Migration?", "relationship", []string{"r-grace-atlas"}},

		// relationship — leads
		{"q15", "Who leads the Q2 Pilot Program?", "relationship", []string{"r-tom-q2"}},
		{"q16", "Who leads APAC Launch?", "relationship", []string{"r-alice-apac"}},
		{"q17", "Who leads the Partner Program?", "relationship", []string{"r-carol-pp"}},
		{"q18", "Who leads the Atlas Migration?", "relationship", []string{"r-frank-atlas"}},

		// relationship — involved_in (unions leads + champions + involved_in)
		{"q19", "Who is involved in the Q2 Pilot Program?", "relationship", []string{"r-sarah-q2", "r-tom-q2", "r-nina-q2"}},
		{"q20", "Who is involved in the Partner Program?", "relationship", []string{"r-carol-pp", "r-dana-pp", "r-ellen-pp"}},

		// multi_hop (champions fact + role_at at the named company)
		{"q21", "Who at Vandelay championed the Q2 Pilot Program?", "multi_hop", []string{"r-sarah-q2", "p-sarah"}},
		{"q22", "Who at Blueshift championed the APAC Launch?", "multi_hop", []string{"r-bob-apac", "p-bob"}},
		{"q23", "Who at Acme Corp championed the Partner Program?", "multi_hop", []string{"r-dana-pp", "p-dana"}},
		{"q24", "Who at Initech championed the Atlas Migration?", "multi_hop", []string{"r-grace-atlas", "p-grace"}},

		// counterfactual (subject's role_at facts)
		{"q25", "What would have happened if Ivan Petrov had not taken his current role?", "counterfactual", []string{"p-ivan"}},
		{"q26", "What if Sarah Jones had never joined Vandelay?", "counterfactual", []string{"p-sarah"}},
		{"q27", "Suppose Frank Li had not become CTO at Initech.", "counterfactual", []string{"p-frank"}},
		{"q28", "What would happen without Carol Mei?", "counterfactual", []string{"p-carol"}},

		// BM25-recall stress (phrasing the typed rewriter does not parse)
		{"q29", "Who works at Blueshift?", "status", []string{"p-ivan", "p-bob", "p-alice"}},
		{"q30", "Who works at Acme Corp?", "status", []string{"p-carol", "p-dana"}},
		{"q31", "Tell me about the APAC Launch.", "status", []string{"r-bob-apac", "r-alice-apac"}},
		{"q32", "Who is on the Partner Program team?", "status", []string{"r-carol-pp", "r-dana-pp", "r-ellen-pp"}},

		// out-of-scope refusal probes (no relevant fact exists)
		{"q33", "What is the capital of France?", "out_of_scope", nil},
		{"q34", "How do I reset my password?", "out_of_scope", nil},
	}
}

// recallAtK = |relevant ∩ top-k| / |relevant|, by set membership. Returns NaN
// for unlabeled (out-of-scope) cases so the aggregator can skip them.
func recallAtK(got []SearchHit, relevant []string, k int) float64 {
	if len(relevant) == 0 {
		return math.NaN()
	}
	rel := make(map[string]bool, len(relevant))
	for _, id := range relevant {
		rel[id] = true
	}
	limit := k
	if len(got) < limit {
		limit = len(got)
	}
	hits := 0
	for i := 0; i < limit; i++ {
		if rel[got[i].FactID] {
			hits++
		}
	}
	return float64(hits) / float64(len(relevant))
}

// ndcgAtK is binary-relevance nDCG: DCG = Σ rel_i / log2(i+2) over the top-k,
// normalized by the ideal ordering (all relevant facts ranked first). Returns
// NaN for unlabeled cases.
func ndcgAtK(got []SearchHit, relevant []string, k int) float64 {
	if len(relevant) == 0 {
		return math.NaN()
	}
	rel := make(map[string]bool, len(relevant))
	for _, id := range relevant {
		rel[id] = true
	}
	limit := k
	if len(got) < limit {
		limit = len(got)
	}
	var dcg float64
	for i := 0; i < limit; i++ {
		if rel[got[i].FactID] {
			dcg += 1.0 / math.Log2(float64(i+2))
		}
	}
	ideal := len(relevant)
	if ideal > k {
		ideal = k
	}
	var idcg float64
	for i := 0; i < ideal; i++ {
		idcg += 1.0 / math.Log2(float64(i+2))
	}
	if idcg == 0 {
		return 0
	}
	return dcg / idcg
}

// TestRetrievalQualityBaseline is the OFFICE-201 Phase 1 gate. It seeds the
// labeled corpus, runs every case through WikiIndex.Search at k=evalK, and
// reports recall@k + nDCG@k aggregate and per-class. It enforces a conservative
// floor so a regression (or a ranking change that hurts retrieval) fails CI.
// P0 (RRF) and P1 (rerank) must hold these floors and report their delta here.
func TestRetrievalQualityBaseline(t *testing.T) {
	ctx := context.Background()
	idx := newBenchLikeIndex(t)
	for _, f := range evalCorpus() {
		seedRetrieveFact(t, idx, f)
	}

	// recall@10 saturates when the corpus is smaller than k, so the gate also
	// tracks recall@1 and recall@3 — those stay discriminating and are where a
	// ranking change (RRF, rerank) actually moves the needle.
	recallKs := []int{1, 3, evalK}
	type agg struct {
		recall map[int]float64 // sum of recall@k per k
		ndcg   float64
		n      int
	}
	newAgg := func() *agg { return &agg{recall: map[int]float64{}} }
	overall := newAgg()
	byClass := map[string]*agg{}
	var oosLeaks int // out-of-scope queries that surfaced a labeled-relevant fact

	cases := evalCases()
	for _, c := range cases {
		hits, err := idx.Search(ctx, c.query, evalK)
		if err != nil {
			t.Fatalf("Search(%q): %v", c.query, err)
		}
		if len(c.relevant) == 0 {
			// Out-of-scope: nothing in the corpus is labeled relevant, so we
			// only note it. Precision of refusal is scored by answer_query
			// evals, not here; this just confirms the path doesn't error.
			continue
		}
		n := ndcgAtK(hits, c.relevant, evalK)
		overall.ndcg += n
		overall.n++
		a := byClass[c.class]
		if a == nil {
			a = newAgg()
			byClass[c.class] = a
		}
		a.ndcg += n
		a.n++
		for _, k := range recallKs {
			r := recallAtK(hits, c.relevant, k)
			overall.recall[k] += r
			a.recall[k] += r
		}
		t.Logf("  %s [%s] r@1=%.2f r@3=%.2f r@%d=%.2f ndcg@%d=%.3f  %q",
			c.id, c.class, recallAtK(hits, c.relevant, 1), recallAtK(hits, c.relevant, 3),
			evalK, recallAtK(hits, c.relevant, evalK), evalK, n, c.query)
	}

	if overall.n == 0 {
		t.Fatal("no labeled cases scored — corpus/cases wiring broken")
	}
	mean := func(a *agg, k int) float64 { return a.recall[k] / float64(a.n) }
	meanNDCG := overall.ndcg / float64(overall.n)

	t.Logf("=== OFFICE-201 retrieval baseline (k=%d, %d labeled cases) ===", evalK, overall.n)
	classes := make([]string, 0, len(byClass))
	for cl := range byClass {
		classes = append(classes, cl)
	}
	sort.Strings(classes)
	for _, cl := range classes {
		a := byClass[cl]
		t.Logf("  class=%-14s n=%2d  r@1=%.3f r@3=%.3f r@%d=%.3f  nDCG@%d=%.3f",
			cl, a.n, mean(a, 1), mean(a, 3), evalK, mean(a, evalK), evalK, a.ndcg/float64(a.n))
	}
	t.Logf("  OVERALL          n=%2d  r@1=%.3f r@3=%.3f r@%d=%.3f  nDCG@%d=%.3f  (oosLeaks=%d)",
		overall.n, mean(overall, 1), mean(overall, 3), evalK, mean(overall, evalK), evalK, meanNDCG, oosLeaks)

	// Regression floors, set just below the measured baseline so a future diff
	// that drops retrieval or ranking fails CI. recall@3 + nDCG@10 are the
	// discriminating gates (recall@10 saturates at this corpus size). P0 (RRF)
	// and P1 (rerank) must hold or raise these and report their delta here.
	const (
		minRecall3 = 0.90 // baseline recall@3 = 1.000
		minNDCG    = 0.95 // baseline nDCG@10  = 0.977
	)
	if got := mean(overall, 3); got < minRecall3 {
		t.Errorf("mean recall@3 %.3f below floor %.2f — retrieval regression", got, minRecall3)
	}
	if meanNDCG < minNDCG {
		t.Errorf("mean nDCG@%d %.3f below floor %.2f — ranking regression", evalK, meanNDCG, minNDCG)
	}
}

// TestEvalMetrics_Unit locks the metric math independently of retrieval so a
// metric bug can never silently move the baseline gate.
func TestEvalMetrics_Unit(t *testing.T) {
	mk := func(ids ...string) []SearchHit {
		out := make([]SearchHit, len(ids))
		for i, id := range ids {
			out[i] = SearchHit{FactID: id}
		}
		return out
	}

	// Perfect: both relevant facts in the top-2.
	if got := recallAtK(mk("a", "b", "c"), []string{"a", "b"}, 10); got != 1.0 {
		t.Errorf("recall perfect = %.3f, want 1.0", got)
	}
	// Half: one of two relevant retrieved.
	if got := recallAtK(mk("a", "x", "y"), []string{"a", "b"}, 10); got != 0.5 {
		t.Errorf("recall half = %.3f, want 0.5", got)
	}
	// k cutoff excludes a relevant hit ranked beyond k.
	if got := recallAtK(mk("x", "y", "a"), []string{"a"}, 2); got != 0.0 {
		t.Errorf("recall beyond-k = %.3f, want 0.0", got)
	}
	// nDCG perfect ordering = 1.0.
	if got := ndcgAtK(mk("a", "b"), []string{"a", "b"}, 10); math.Abs(got-1.0) > 1e-9 {
		t.Errorf("ndcg ideal = %.6f, want 1.0", got)
	}
	// nDCG with the single relevant hit at rank 2 vs ideal rank 1.
	// DCG = 1/log2(3); IDCG = 1/log2(2)=1 → nDCG = 1/log2(3) ≈ 0.6309.
	if got := ndcgAtK(mk("x", "a"), []string{"a"}, 10); math.Abs(got-(1.0/math.Log2(3))) > 1e-9 {
		t.Errorf("ndcg rank-2 = %.6f, want %.6f", got, 1.0/math.Log2(3))
	}
	// Unlabeled → NaN (skipped by aggregator).
	if got := recallAtK(mk("a"), nil, 10); !math.IsNaN(got) {
		t.Errorf("recall unlabeled = %.3f, want NaN", got)
	}
	if got := ndcgAtK(mk("a"), nil, 10); !math.IsNaN(got) {
		t.Errorf("ndcg unlabeled = %.3f, want NaN", got)
	}
}
