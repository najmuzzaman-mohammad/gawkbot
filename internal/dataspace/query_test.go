package dataspace

import "testing"

type queryKit struct {
	*kit
	investor string
	firm     string
}

// The same five rows the mock's query tests use, so the expectations below can
// be read next to web/src/api/dataspaces.mock.query.test.ts.
var queryRows = []map[string]any{
	{"name": "Mirela", "stage": "Pitched", "check": 250000, "met": "2026-08-02", "warm": true, "email": "mirela@tidewrack.example"},
	{"name": "Tobias", "stage": "Intro", "met": "2026-07-15", "warm": false},
	{"name": "Anneke", "stage": "Committed", "check": 50000, "email": "anneke@halcyonspur.example"},
	{"name": "Desmond", "check": 100000, "met": "2026-09-01", "warm": true},
	{"name": "Priyanka", "stage": "Intro", "check": 100000, "met": "2026-06-20", "email": "priyanka@northlantern.example"},
}

func newQueryKit(t *testing.T) *queryKit {
	t.Helper()
	k := newKit(t)
	firm := k.typ("Firm")
	investor := k.typ("Investor")
	k.attr(investor.ID, AttributeInput{
		Name: "Stage", Type: TypeStatus, Options: []string{"Intro", "Pitched", "Committed"},
	})
	k.attr(investor.ID, AttributeInput{Name: "Check", Type: TypeCurrency})
	k.attr(investor.ID, AttributeInput{Name: "Met", Type: TypeDate})
	k.attr(investor.ID, AttributeInput{Name: "Warm", Type: TypeToggle})
	k.attr(investor.ID, AttributeInput{Name: "Email", Type: TypeEmail})
	k.relate(investor.ID, "Firm", firm.ID, CardinalityManyToOne, "Investors")

	tidewrack := k.create(firm.ID, map[string]any{"name": "Tidewrack Capital"})
	var mirela string
	for _, row := range queryRows {
		created := k.create(investor.ID, row)
		if row["name"] == "Mirela" {
			mirela = created.ID
		}
	}
	k.mustLink(mirela, "firm", tidewrack.ID, false)
	return &queryKit{kit: k, investor: investor.ID, firm: firm.ID}
}

func (q *queryKit) run(t *testing.T, query Query) ([]string, int) {
	t.Helper()
	if query.ObjectType == "" {
		query.ObjectType = q.investor
	}
	if query.Limit == 0 {
		query.Limit = 100
	}
	page, err := q.store.QueryRecords(q.ctx, q.actor, q.spaceID, query)
	if err != nil {
		t.Fatalf("QueryRecords: %v", err)
	}
	names := make([]string, 0, len(page.Records))
	for _, record := range page.Records {
		names = append(names, valueString(record.Values["name"]))
	}
	return names, page.Total
}

func (q *queryKit) runErr(query Query) error {
	if query.ObjectType == "" {
		query.ObjectType = q.investor
	}
	if query.Limit == 0 {
		query.Limit = 100
	}
	_, err := q.store.QueryRecords(q.ctx, q.actor, q.spaceID, query)
	return err
}

func TestQueryFilters(t *testing.T) {
	cases := []struct {
		label  string
		filter Filter
		want   []string
	}{
		{"status equals by option name, any case",
			Filter{Attribute: "stage", Operator: OpEquals, Value: " intro "},
			[]string{"Tobias", "Priyanka"}},
		{"status not_equals includes empties",
			Filter{Attribute: "stage", Operator: OpNotEquals, Value: "Intro"},
			[]string{"Mirela", "Anneke", "Desmond"}},
		{"status contains",
			Filter{Attribute: "stage", Operator: OpContains, Value: "itch"},
			[]string{"Mirela"}},
		{"currency equals numerically",
			Filter{Attribute: "check", Operator: OpEquals, Value: "100000.0"},
			[]string{"Desmond", "Priyanka"}},
		{"currency greater is numeric, not lexical",
			Filter{Attribute: "check", Operator: OpGreater, Value: "90000"},
			[]string{"Mirela", "Desmond", "Priyanka"}},
		{"currency less skips empties",
			Filter{Attribute: "check", Operator: OpLess, Value: "100000"},
			[]string{"Anneke"}},
		{"date greater by string compare",
			Filter{Attribute: "met", Operator: OpGreater, Value: "2026-07-31"},
			[]string{"Mirela", "Desmond"}},
		{"date less",
			Filter{Attribute: "met", Operator: OpLess, Value: "2026-07-01"},
			[]string{"Priyanka"}},
		{"is_empty",
			Filter{Attribute: "email", Operator: OpIsEmpty},
			[]string{"Tobias", "Desmond"}},
		{"is_not_empty",
			Filter{Attribute: "check", Operator: OpIsNotEmpty},
			[]string{"Mirela", "Anneke", "Desmond", "Priyanka"}},
		{"toggle equals true",
			Filter{Attribute: "warm", Operator: OpEquals, Value: "true"},
			[]string{"Mirela", "Desmond"}},
		{"toggle equals false counts unset as false",
			Filter{Attribute: "warm", Operator: OpEquals, Value: "false"},
			[]string{"Tobias", "Anneke", "Priyanka"}},
		{"relationship contains by linked record name",
			Filter{Attribute: "firm", Operator: OpContains, Value: "tidewrack"},
			[]string{"Mirela"}},
		{"relationship is_empty",
			Filter{Attribute: "firm", Operator: OpIsEmpty},
			[]string{"Tobias", "Anneke", "Desmond", "Priyanka"}},
		{"system field _created_by",
			Filter{Attribute: "_created_by", Operator: OpEquals, Value: string(testOwner)},
			[]string{"Mirela", "Tobias", "Anneke", "Desmond", "Priyanka"}},
	}
	q := newQueryKit(t)
	for _, tc := range cases {
		t.Run(tc.label, func(t *testing.T) {
			names, total := q.run(t, Query{Filters: []Filter{tc.filter}})
			if !equalStrings(names, tc.want) {
				t.Fatalf("names = %v, want %v", names, tc.want)
			}
			if total != len(tc.want) {
				t.Fatalf("total = %d, want %d", total, len(tc.want))
			}
		})
	}
}

func TestQueryANDsClauses(t *testing.T) {
	q := newQueryKit(t)
	names, _ := q.run(t, Query{Filters: []Filter{
		{Attribute: "stage", Operator: OpEquals, Value: "Intro"},
		{Attribute: "check", Operator: OpIsNotEmpty},
	}})
	if !equalStrings(names, []string{"Priyanka"}) {
		t.Fatalf("names = %v", names)
	}
}

func TestQueryFilterErrors(t *testing.T) {
	q := newQueryKit(t)
	requireValidation(t, q.runErr(Query{Filters: []Filter{{Attribute: "nope", Operator: OpIsEmpty}}}),
		"Valid attributes: name, stage")
	requireValidation(t, q.runErr(Query{Filters: []Filter{{Attribute: "stage", Operator: OpEquals}}}),
		"needs a value")
	requireValidation(t, q.runErr(Query{Filters: []Filter{{Attribute: "stage", Operator: Operator("like"), Value: "x"}}}),
		"not a filter operator")
	requireValidation(t, q.runErr(Query{Filters: []Filter{{Attribute: "check", Operator: OpGreater, Value: "lots"}}}),
		"needs a number")
}

func TestQuerySearch(t *testing.T) {
	q := newQueryKit(t)
	cases := []struct {
		needle string
		want   []string
	}{
		{"ANN", []string{"Anneke"}},
		{"northlantern", []string{"Priyanka"}},
		{"committed", []string{"Anneke"}},
		// Numbers and dates are not text-like.
		{"250000", []string{}},
	}
	for _, tc := range cases {
		names, _ := q.run(t, Query{Search: tc.needle})
		if !equalStrings(names, tc.want) {
			t.Fatalf("search %q = %v, want %v", tc.needle, names, tc.want)
		}
	}
	if _, total := q.run(t, Query{Search: "   "}); total != 5 {
		t.Fatalf("blank search total = %d", total)
	}
}

func TestQuerySort(t *testing.T) {
	cases := []struct {
		attribute string
		desc      bool
		want      []string
	}{
		{"name", false, []string{"Anneke", "Desmond", "Mirela", "Priyanka", "Tobias"}},
		{"name", true, []string{"Tobias", "Priyanka", "Mirela", "Desmond", "Anneke"}},
		// Option order (Intro, Pitched, Committed), not alphabetical; empties last.
		{"stage", false, []string{"Tobias", "Priyanka", "Mirela", "Anneke", "Desmond"}},
		{"stage", true, []string{"Anneke", "Mirela", "Tobias", "Priyanka", "Desmond"}},
		{"check", false, []string{"Anneke", "Desmond", "Priyanka", "Mirela", "Tobias"}},
		{"check", true, []string{"Mirela", "Desmond", "Priyanka", "Anneke", "Tobias"}},
		{"met", false, []string{"Priyanka", "Tobias", "Mirela", "Desmond", "Anneke"}},
		{"met", true, []string{"Desmond", "Mirela", "Tobias", "Priyanka", "Anneke"}},
		{"warm", true, []string{"Mirela", "Desmond", "Tobias", "Anneke", "Priyanka"}},
		{"_created_at", true, []string{"Priyanka", "Desmond", "Anneke", "Tobias", "Mirela"}},
	}
	q := newQueryKit(t)
	for _, tc := range cases {
		t.Run(tc.attribute, func(t *testing.T) {
			names, _ := q.run(t, Query{Sort: &Sort{Attribute: tc.attribute, Desc: tc.desc}})
			if !equalStrings(names, tc.want) {
				t.Fatalf("sort %s desc=%v = %v, want %v", tc.attribute, tc.desc, names, tc.want)
			}
		})
	}
}

func TestQuerySortErrors(t *testing.T) {
	q := newQueryKit(t)
	requireValidation(t, q.runErr(Query{Sort: &Sort{Attribute: "firm"}}), "cannot be sorted by the relationship")
	requireValidation(t, q.runErr(Query{Sort: &Sort{Attribute: "nope"}}), "is not an attribute")
}

func TestQueryPagination(t *testing.T) {
	q := newQueryKit(t)
	sort := &Sort{Attribute: "name"}
	filters := []Filter{{Attribute: "check", Operator: OpIsNotEmpty}}
	one, totalOne := q.run(t, Query{Sort: sort, Filters: filters, Limit: 3})
	two, totalTwo := q.run(t, Query{Sort: sort, Filters: filters, Limit: 3, Offset: 3})
	beyond, totalBeyond := q.run(t, Query{Sort: sort, Filters: filters, Limit: 3, Offset: 30})
	if !equalStrings(one, []string{"Anneke", "Desmond", "Mirela"}) {
		t.Fatalf("page one = %v", one)
	}
	if !equalStrings(two, []string{"Priyanka"}) {
		t.Fatalf("page two = %v", two)
	}
	if len(beyond) != 0 {
		t.Fatalf("beyond = %v", beyond)
	}
	if totalOne != 4 || totalTwo != 4 || totalBeyond != 4 {
		t.Fatalf("totals = %d %d %d", totalOne, totalTwo, totalBeyond)
	}
}

func TestQueryLimitDefaultsAndBounds(t *testing.T) {
	q := newQueryKit(t)
	page, err := q.store.QueryRecords(q.ctx, q.actor, q.spaceID, Query{ObjectType: q.investor})
	if err != nil {
		t.Fatalf("QueryRecords: %v", err)
	}
	if len(page.Records) != 5 || page.Total != 5 {
		t.Fatalf("default page = %d of %d", len(page.Records), page.Total)
	}
	requireValidation(t, q.runErr(Query{Limit: -1}), "limit must be")
	requireValidation(t, q.runErr(Query{Limit: 5000}), "cannot exceed")
	requireValidation(t, q.runErr(Query{Offset: -1}), "offset must be")
	requireValidation(t, q.runErr(Query{ObjectType: "type_nope"}), "Unknown object type")
}

func TestQueryResolvesTypeBySlugAndName(t *testing.T) {
	q := newQueryKit(t)
	for _, ref := range []string{"investor", "Investor", "Investors"} {
		if _, total := q.run(t, Query{ObjectType: ref}); total != 5 {
			t.Fatalf("type ref %q returned %d records", ref, total)
		}
	}
}
