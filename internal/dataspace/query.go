package dataspace

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// DefaultQueryLimit is the page size a query gets when it asks for none.
const DefaultQueryLimit = 30

// MaxQueryLimit is the largest page a single query may ask for.
const MaxQueryLimit = 1000

// SystemFields are the three fields every record has besides its attributes.
// They start with "_", which no attribute slug can, so they never collide.
var SystemFields = []string{"_created_at", "_updated_at", "_created_by"}

var (
	numericTypes  = []AttributeType{TypeNumber, TypeCurrency, TypeRating}
	searchedTypes = []AttributeType{TypeText, TypeEmail, TypeURL, TypePhone, TypeSelect, TypeStatus}
	operators     = []Operator{OpEquals, OpNotEquals, OpContains, OpGreater, OpLess, OpIsEmpty, OpIsNotEmpty}
)

func isSystemField(slug string) bool {
	for _, field := range SystemFields {
		if field == slug {
			return true
		}
	}
	return false
}

func isNumericType(t AttributeType) bool {
	for _, item := range numericTypes {
		if item == t {
			return true
		}
	}
	return false
}

func isSearchedType(t AttributeType) bool {
	for _, item := range searchedTypes {
		if item == t {
			return true
		}
	}
	return false
}

func isOperator(op Operator) bool {
	for _, item := range operators {
		if item == op {
			return true
		}
	}
	return false
}

func joinOperators() string {
	names := make([]string, 0, len(operators))
	for _, item := range operators {
		names = append(names, string(item))
	}
	return strings.Join(names, ", ")
}

// field is either one of the three system fields or one attribute.
type field struct {
	system string
	attr   *Attribute
}

func resolveField(entry *typeEntry, slug string) (field, error) {
	if isSystemField(slug) {
		return field{system: slug}, nil
	}
	if attr := resolveAttributeRef(entry, slug); attr != nil {
		return field{attr: attr}, nil
	}
	slugs := make([]string, 0, len(entry.Attrs))
	for _, attr := range entry.Attrs {
		slugs = append(slugs, attr.Slug)
	}
	return field{}, Invalid(slug, "%q is not an attribute of %s. Valid attributes: %s.",
		slug, entry.Name, strings.Join(slugs, ", "))
}

func systemValue(record Record, slug string) string {
	switch slug {
	case "_created_at":
		return record.CreatedAt
	case "_updated_at":
		return record.UpdatedAt
	default:
		return record.CreatedBy
	}
}

// displayValues is what a person sees in the cell: option names and linked
// record names, not ids. Filters and search compare against these.
func displayValues(record Record, f field) []string {
	if f.attr == nil {
		return []string{systemValue(record, f.system)}
	}
	attr := f.attr
	if attr.Type == TypeRelationship {
		refs := record.Links[attr.Slug]
		out := make([]string, 0, len(refs))
		for _, ref := range refs {
			out = append(out, ref.Name)
		}
		return out
	}
	raw, ok := record.Values[attr.Slug]
	if !ok || raw == nil {
		return []string{}
	}
	items := []string{}
	if list, isSlice := raw.([]string); isSlice {
		items = append(items, list...)
	} else {
		items = append(items, valueString(raw))
	}
	if attr.Type == TypeSelect || attr.Type == TypeStatus {
		named := make([]string, 0, len(items))
		for _, id := range items {
			name := id
			for _, option := range attr.Options {
				if option.ID == id {
					name = option.Name
					break
				}
			}
			named = append(named, name)
		}
		return named
	}
	return items
}

func numericOperand(clause Filter) (float64, error) {
	text := strings.TrimSpace(clause.Value)
	parsed, err := strconv.ParseFloat(text, 64)
	if text == "" || err != nil {
		return 0, Invalid(clause.Attribute,
			"Filter on %q needs a number; got %q.", clause.Attribute, clause.Value)
	}
	return parsed, nil
}

func matchesClause(record Record, f field, clause Filter) (bool, error) {
	shown := displayValues(record, f)
	switch clause.Operator {
	case OpIsEmpty:
		return len(shown) == 0, nil
	case OpIsNotEmpty:
		return len(shown) > 0, nil
	}
	wanted := strings.ToLower(strings.TrimSpace(clause.Value))
	values := shown
	// An unset toggle reads as "false", the same way the table renders it.
	if f.attr != nil && f.attr.Type == TypeToggle && len(shown) == 0 {
		values = []string{"false"}
	}
	lowered := make([]string, 0, len(values))
	for _, value := range values {
		lowered = append(lowered, strings.ToLower(strings.TrimSpace(value)))
	}
	numeric := f.attr != nil && isNumericType(f.attr.Type)

	switch clause.Operator {
	case OpEquals, OpNotEquals:
		isEqual := false
		if numeric {
			operand, err := numericOperand(clause)
			if err != nil {
				return false, err
			}
			for _, value := range values {
				if parsed, parseErr := strconv.ParseFloat(strings.TrimSpace(value), 64); parseErr == nil && parsed == operand {
					isEqual = true
				}
			}
		} else {
			for _, value := range lowered {
				if value == wanted {
					isEqual = true
				}
			}
		}
		if clause.Operator == OpEquals {
			return isEqual, nil
		}
		return !isEqual, nil
	case OpContains:
		for _, value := range lowered {
			if strings.Contains(value, wanted) {
				return true, nil
			}
		}
		return false, nil
	case OpGreater, OpLess:
		greater := clause.Operator == OpGreater
		if numeric {
			operand, err := numericOperand(clause)
			if err != nil {
				return false, err
			}
			for _, value := range values {
				parsed, parseErr := strconv.ParseFloat(strings.TrimSpace(value), 64)
				if parseErr != nil {
					continue
				}
				if (greater && parsed > operand) || (!greater && parsed < operand) {
					return true, nil
				}
			}
			return false, nil
		}
		// Dates are YYYY-MM-DD, so a plain string compare orders them.
		for _, value := range lowered {
			if (greater && value > wanted) || (!greater && value < wanted) {
				return true, nil
			}
		}
		return false, nil
	default:
		return false, &ValidationError{Message: fmt.Sprintf(
			"Unknown filter operator %q.", string(clause.Operator))}
	}
}

func assertClause(clause Filter, given bool) error {
	if !isOperator(clause.Operator) {
		return Invalid(clause.Attribute, "%q is not a filter operator. Valid: %s.",
			string(clause.Operator), joinOperators())
	}
	needsValue := clause.Operator != OpIsEmpty && clause.Operator != OpIsNotEmpty
	if needsValue && !given {
		return Invalid(clause.Attribute, "Filter %q on %q needs a value.",
			string(clause.Operator), clause.Attribute)
	}
	return nil
}

func matchesSearch(record Record, entry *typeEntry, needle string) bool {
	for _, attr := range entry.Attrs {
		if !attr.IsPrimary && !isSearchedType(attr.Type) {
			continue
		}
		for _, value := range displayValues(record, field{attr: attr}) {
			if strings.Contains(strings.ToLower(value), needle) {
				return true
			}
		}
	}
	return false
}

// sortKey is the comparable projection of one field. An empty value sorts last
// whichever way the column is pointed.
type sortKey struct {
	empty  bool
	number float64
	text   string
	isText bool
}

func keyFor(record Record, f field) sortKey {
	if f.attr == nil {
		return sortKey{text: strings.ToLower(systemValue(record, f.system)), isText: true}
	}
	attr := f.attr
	raw, ok := record.Values[attr.Slug]
	if !ok || raw == nil {
		return sortKey{empty: true}
	}
	if attr.Type == TypeSelect || attr.Type == TypeStatus {
		ids := []string{}
		if list, isSlice := raw.([]string); isSlice {
			ids = append(ids, list...)
		} else {
			ids = append(ids, valueString(raw))
		}
		best := -1
		for _, id := range ids {
			for index, option := range attr.Options {
				if option.ID == id && (best < 0 || index < best) {
					best = index
				}
			}
		}
		if best < 0 {
			return sortKey{empty: true}
		}
		return sortKey{number: float64(best)}
	}
	switch value := raw.(type) {
	case bool:
		if value {
			return sortKey{number: 1}
		}
		return sortKey{number: 0}
	case []string:
		return sortKey{text: strings.ToLower(strings.Join(value, ", ")), isText: true}
	case string:
		return sortKey{text: strings.ToLower(value), isText: true}
	default:
		if number, isNumber := asFloat(raw); isNumber {
			return sortKey{number: number}
		}
		return sortKey{text: strings.ToLower(valueString(raw)), isText: true}
	}
}

func compareKeys(a, b sortKey, direction int) int {
	if a.empty && b.empty {
		return 0
	}
	if a.empty {
		return 1
	}
	if b.empty {
		return -1
	}
	if a.isText != b.isText {
		// Mixed shapes cannot happen within one attribute; order by rendering.
		left, right := a.text, b.text
		if !a.isText {
			left = strconv.FormatFloat(a.number, 'f', -1, 64)
		}
		if !b.isText {
			right = strconv.FormatFloat(b.number, 'f', -1, 64)
		}
		if left == right {
			return 0
		}
		if left < right {
			return -direction
		}
		return direction
	}
	if a.isText {
		if a.text == b.text {
			return 0
		}
		if a.text < b.text {
			return -direction
		}
		return direction
	}
	if a.number == b.number {
		return 0
	}
	if a.number < b.number {
		return -direction
	}
	return direction
}

func (s *store) QueryRecords(ctx context.Context, actor Actor, spaceID string, query Query) (Page, error) {
	_, _, unlock, err := s.lockSpace(ctx, actor, spaceID, false)
	if err != nil {
		return Page{}, err
	}
	defer unlock()
	limit := query.Limit
	if limit == 0 {
		limit = DefaultQueryLimit
	}
	if limit < 1 {
		return Page{}, &ValidationError{Message: fmt.Sprintf(
			"limit must be a whole number of at least 1; got %d.", query.Limit)}
	}
	if limit > MaxQueryLimit {
		return Page{}, &ValidationError{Message: fmt.Sprintf(
			"limit cannot exceed %d; got %d.", MaxQueryLimit, query.Limit)}
	}
	if query.Offset < 0 {
		return Page{}, &ValidationError{Message: fmt.Sprintf(
			"offset must be a whole number of at least 0; got %d.", query.Offset)}
	}
	// Both caps bound one call's work. Every filter is evaluated against every
	// record of the type, and the search needle is compared to every text-like
	// value, so without a cap one request can hold the space lock for seconds
	// — which a bot reaches by accident as readily as on purpose.
	if len(query.Filters) > MaxFiltersPerQuery {
		return Page{}, &ValidationError{Message: fmt.Sprintf(
			"A query takes at most %d filters; got %d. Narrow the query, or filter the results yourself.",
			MaxFiltersPerQuery, len(query.Filters))}
	}
	if len(query.Search) > MaxSearchBytes {
		return Page{}, &ValidationError{Message: fmt.Sprintf(
			"A search term is at most %d characters; got %d.",
			MaxSearchBytes, len(query.Search))}
	}

	var page Page
	err = s.inReadTx(ctx, spaceID, func(tx *sql.Tx) error {
		snapshot, loadErr := loadSchema(ctx, tx)
		if loadErr != nil {
			return loadErr
		}
		entry, typeErr := snapshot.requireType(query.ObjectType)
		if typeErr != nil {
			return typeErr
		}
		type clause struct {
			filter Filter
			field  field
		}
		clauses := make([]clause, 0, len(query.Filters))
		for _, filter := range query.Filters {
			if err := assertClause(filter, filter.Value != ""); err != nil {
				return err
			}
			resolved, fieldErr := resolveField(entry, filter.Attribute)
			if fieldErr != nil {
				return fieldErr
			}
			clauses = append(clauses, clause{filter: filter, field: resolved})
		}
		var sortField *field
		if query.Sort != nil {
			resolved, fieldErr := resolveField(entry, query.Sort.Attribute)
			if fieldErr != nil {
				return fieldErr
			}
			if resolved.attr != nil && resolved.attr.Type == TypeRelationship {
				return Invalid(resolved.attr.Slug,
					"Records cannot be sorted by the relationship %q.", resolved.attr.Slug)
			}
			sortField = &resolved
		}

		scope := scopeType(entry.ID)
		// The only pushdown that translates exactly: an empty or non-empty
		// value is "is there a row", which SQL answers without loading it.
		for _, item := range clauses {
			if item.field.attr == nil || item.field.attr.Type == TypeRelationship {
				continue
			}
			switch item.filter.Operator {
			case OpIsEmpty:
				scope.where += ` AND NOT EXISTS (SELECT 1 FROM record_values rv WHERE rv.record_id = records.id AND rv.attribute_id = ?)`
				scope.args = append(scope.args, item.field.attr.ID)
			case OpIsNotEmpty:
				scope.where += ` AND EXISTS (SELECT 1 FROM record_values rv WHERE rv.record_id = records.id AND rv.attribute_id = ?)`
				scope.args = append(scope.args, item.field.attr.ID)
			}
		}

		// TODO(dataspace): this loads every record of the object type to serve
		// one page — measured at 699ms and 130MB at 100k records — because
		// only IsEmpty and IsNotEmpty push down into SQL and the rest of the
		// filtering, the search and the sort all happen in Go. Pushing the
		// remaining operators and the sort into the query is a bigger change
		// than this slice; the caps above bound the damage until then.
		stored, recErr := loadStoredRecords(ctx, tx, scope)
		if recErr != nil {
			return recErr
		}
		views, viewErr := viewRecords(ctx, tx, snapshot, stored, scope)
		if viewErr != nil {
			return viewErr
		}
		needle := strings.ToLower(strings.TrimSpace(query.Search))
		rows := make([]Record, 0, len(views))
		for _, record := range views {
			keep := true
			for _, item := range clauses {
				match, matchErr := matchesClause(record, item.field, item.filter)
				if matchErr != nil {
					return matchErr
				}
				if !match {
					keep = false
					break
				}
			}
			if keep && needle != "" && !matchesSearch(record, entry, needle) {
				keep = false
			}
			if keep {
				rows = append(rows, record)
			}
		}
		if sortField != nil {
			direction := 1
			if query.Sort.Desc {
				direction = -1
			}
			// Stable, so creation order breaks ties the way the mock's index
			// tie-break does.
			sort.SliceStable(rows, func(i, j int) bool {
				return compareKeys(keyFor(rows[i], *sortField), keyFor(rows[j], *sortField), direction) < 0
			})
		}
		page.Total = len(rows)
		start := query.Offset
		if start > len(rows) {
			start = len(rows)
		}
		end := start + limit
		if end > len(rows) {
			end = len(rows)
		}
		page.Records = append([]Record{}, rows[start:end]...)
		return nil
	})
	if err != nil {
		return Page{}, err
	}
	return page, nil
}
