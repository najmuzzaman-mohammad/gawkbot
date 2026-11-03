package dataspace

import (
	"errors"
	"fmt"
	"strings"
)

// resultBuilder collects one Entry per request item, in request order, and
// renders the Result envelope every batch write returns.
type resultBuilder struct {
	noun    string // "object type", "record", "link"
	verb    string // "created", "linked"
	entries []Entry
	ok      int
	noop    int
	failed  int
}

func newResult(noun, verb string, capacity int) *resultBuilder {
	return &resultBuilder{noun: noun, verb: verb, entries: make([]Entry, 0, capacity)}
}

func (r *resultBuilder) add(index int, identifier string, id string) {
	r.entries = append(r.entries, Entry{
		Index: index, Identifier: identifier, Status: StatusOK, ID: id,
	})
	r.ok++
}

func (r *resultBuilder) addNoop(index int, identifier string, id string) {
	r.entries = append(r.entries, Entry{
		Index: index, Identifier: identifier, Status: StatusNoop, ID: id,
	})
	r.noop++
}

func (r *resultBuilder) addError(index int, identifier string, err error) {
	entry := Entry{
		Index: index, Identifier: identifier, Status: StatusFailed, Error: err.Error(),
	}
	var invalid *ValidationError
	if errors.As(err, &invalid) {
		entry.Attribute = invalid.Attribute
	}
	r.entries = append(r.entries, entry)
	r.failed++
}

func (r *resultBuilder) result() Result {
	parts := []string{}
	if r.ok > 0 {
		parts = append(parts, fmt.Sprintf("%d %s", r.ok, r.verb))
	}
	if r.noop > 0 {
		parts = append(parts, fmt.Sprintf("%d unchanged", r.noop))
	}
	if r.failed > 0 {
		parts = append(parts, fmt.Sprintf("%d failed", r.failed))
	}
	if len(parts) == 0 {
		parts = append(parts, "nothing to do")
	}
	plural := r.noun
	if !strings.HasSuffix(plural, "s") {
		plural += "s"
	}
	return Result{
		// A no-op counts as succeeded: the caller asked for a state and the
		// store is in it.
		Succeeded: r.ok + r.noop,
		Failed:    r.failed,
		Summary:   fmt.Sprintf("%s: %s", plural, strings.Join(parts, ", ")),
		Entries:   r.entries,
	}
}

// isFatal separates a problem with one entry, which fails that entry and lets
// the rest of the batch land, from a problem with the store, which aborts the
// whole call so nothing is written on a half-broken transaction.
func isFatal(err error) bool {
	if err == nil {
		return false
	}
	var invalid *ValidationError
	if errors.As(err, &invalid) {
		return false
	}
	var forbidden *ForbiddenError
	if errors.As(err, &forbidden) {
		return false
	}
	return !errors.Is(err, ErrNotFound) && !errors.Is(err, ErrForbidden)
}

// tooMany is the single error a call gets when it exceeds a per-call limit.
// Nothing is written: the caller splits the batch and tries again.
func tooMany(noun string, count, limit int) error {
	return &ValidationError{Message: fmt.Sprintf(
		"%d %s in one call; at most %d are accepted. Split the call.", count, noun, limit)}
}
