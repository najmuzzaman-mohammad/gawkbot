package dataspace

import (
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The package returns two different not-founds and the broker tells them apart
// by whether a message came with it:
//
//   - a BARE ErrNotFound, which is what an access denial returns, becomes an
//     opaque 404 so a bot cannot probe for another bot's spaces;
//   - a *notFoundError, which is what an id that names nothing inside a space
//     the caller can already read returns, becomes a 404 that carries the
//     message so the bot can correct its own typo.
//
// The three tests below pin that split from the store's side: the denials
// carry nothing, the addressing failures carry something, and the table names
// every notFound( call site so a new one cannot land unclassified.

// TestAccessDenialsCarryNoMessage is the leak test. Every Store method, called
// by a bot with no access at all, must come back as a bare ErrNotFound: no
// message, no attribute, nothing that distinguishes "you may not see this"
// from "this does not exist".
func TestAccessDenialsCarryNoMessage(t *testing.T) {
	a := newAccessKit(t)
	const stranger Actor = "stranger"
	for _, call := range storeCalls() {
		t.Run(call.name, func(t *testing.T) {
			assertBareNotFound(t, call.run(a, stranger))
		})
	}
	t.Run("unknown space", func(t *testing.T) {
		_, err := a.store.GetSchema(a.ctx, a.actor, "space_ffffffffffffffff")
		assertBareNotFound(t, err)
	})
	t.Run("empty actor", func(t *testing.T) {
		_, err := a.store.GetSchema(a.ctx, "", a.spaceID)
		assertBareNotFound(t, err)
	})
}

func assertBareNotFound(t *testing.T, err error) {
	t.Helper()
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("got %v, want ErrNotFound", err)
	}
	var invalid *ValidationError
	if errors.As(err, &invalid) {
		t.Fatalf("an access denial carried message %q and attribute %q; "+
			"that tells a bot the space exists", invalid.Message, invalid.Attribute)
	}
	var forbidden *ForbiddenError
	if errors.As(err, &forbidden) {
		t.Fatalf("an access denial named an owner: %v", err)
	}
	if err.Error() != "not found" {
		t.Fatalf("an access denial reads as %q, want an opaque %q", err.Error(), "not found")
	}
}

// notFoundSite is one notFound( call site and the shortest way to reach it.
type notFoundSite struct {
	// file and site put the case next to the code it covers.
	file string
	site string
	// run reaches it. Nil when the site is defensive and cannot be reached
	// through the public API; the case is then checked against the source
	// instead, which is weaker but still fails if someone makes it bare.
	run  func(a *accessKit) error
	want string
}

func notFoundSites() []notFoundSite {
	name := "x"
	return []notFoundSite{
		{
			file: "attributes.go",
			site: "AddAttributes, the resolved type vanished mid-loop",
			// Defensive: the space lock and the surrounding transaction mean
			// the type resolved a few lines above cannot disappear.
			want: "Unknown object type",
		},
		{
			file: "attributes.go",
			site: "UpdateAttribute, unknown attribute id",
			run: func(a *accessKit) error {
				_, err := a.store.UpdateAttribute(a.ctx, a.actor, a.spaceID, a.thing,
					"attr_nope", AttributePatch{Name: &name})
				return err
			},
			want: "has no attribute with id",
		},
		{
			file: "model.go",
			site: "requireType, unknown object type",
			run: func(a *accessKit) error {
				_, err := a.store.QueryRecords(a.ctx, a.actor, a.spaceID, Query{ObjectType: "type_nope"})
				return err
			},
			want: "Unknown object type",
		},
		{
			file: "records.go",
			site: "GetRecord, unknown record",
			run: func(a *accessKit) error {
				_, err := a.store.GetRecord(a.ctx, a.actor, a.spaceID, "rec_nope")
				return err
			},
			want: "Unknown record",
		},
		{
			file: "records.go",
			site: "requireMatchAttribute, the upsert match names nothing",
			run: func(a *accessKit) error {
				_, err := a.store.UpsertRecords(a.ctx, a.actor, a.spaceID, a.thing, "nope",
					[]RecordInput{{Values: map[string]any{"name": "Five"}}})
				return err
			},
			want: "cannot match an upsert",
		},
		{
			file: "records.go",
			site: "updateRecordValues, the matched record vanished",
			// Defensive through the public API, reachable directly.
			run: func(a *accessKit) error {
				return a.store.inTx(a.ctx, a.spaceID, func(tx *sql.Tx) error {
					snapshot, loadErr := loadSchema(a.ctx, tx)
					if loadErr != nil {
						return loadErr
					}
					entry := snapshot.typeByID(a.thing)
					return updateRecordValues(a.ctx, tx, a.store, entry, "rec_nope",
						map[string]any{"name": "x"})
				})
			},
			want: "Unknown record",
		},
		{
			file: "records.go",
			site: "UpdateRecord, unknown record",
			run: func(a *accessKit) error {
				_, err := a.store.UpdateRecord(a.ctx, a.actor, a.spaceID, "rec_nope",
					map[string]any{"name": "x"})
				return err
			},
			want: "Unknown record",
		},
		{
			file: "links.go",
			site: "requireStoredRecord, unknown record",
			// Link reports this per entry, so the site is exercised directly to
			// keep the error value itself in view.
			run: func(a *accessKit) error {
				return a.store.inTx(a.ctx, a.spaceID, func(tx *sql.Tx) error {
					_, err := requireStoredRecord(a.ctx, tx, "rec_nope")
					return err
				})
			},
			want: "Unknown record",
		},
		{
			file: "delete.go",
			site: "planRecords, unknown record ids",
			run: func(a *accessKit) error {
				_, err := a.store.PreviewDelete(a.ctx, a.actor, a.spaceID, DeleteRecords,
					[]string{"rec_nope"})
				return err
			},
			want: "Unknown record ids",
		},
		{
			file: "delete.go",
			site: "planAttributes, unknown attribute id",
			run: func(a *accessKit) error {
				_, err := a.store.PreviewDelete(a.ctx, a.actor, a.spaceID, DeleteAttribute,
					[]string{"attr_nope"})
				return err
			},
			want: "Unknown attribute id",
		},
		{
			file: "delete.go",
			site: "planTypes, unknown object type ids",
			run: func(a *accessKit) error {
				_, err := a.store.PreviewDelete(a.ctx, a.actor, a.spaceID, DeleteObjectType,
					[]string{"type_nope"})
				return err
			},
			want: "Unknown object type ids",
		},
		{
			file: "delete.go",
			site: "planRecordsOfType, unknown object type ids",
			run: func(a *accessKit) error {
				_, err := a.store.PreviewDelete(a.ctx, a.actor, a.spaceID, DeleteRecordsOfType,
					[]string{"type_nope"})
				return err
			},
			want: "Unknown object type ids",
		},
	}
}

// TestInSpaceNotFoundsCarryAMessage is the other half: an id that names
// nothing inside a space the caller can read comes back as a *notFoundError,
// so the broker answers 404 AND hands the bot the sentence that lets it fix
// the call itself.
func TestInSpaceNotFoundsCarryAMessage(t *testing.T) {
	a := newAccessKit(t)
	for _, site := range notFoundSites() {
		t.Run(site.file+": "+site.site, func(t *testing.T) {
			if site.run == nil {
				// Unreachable through the public API, so the source is the only
				// witness: the site must still build its error with notFound,
				// not with a bare ErrNotFound.
				requireNotFoundInSource(t, site.file, site.want)
				return
			}
			err := site.run(a)
			if err == nil {
				t.Fatalf("expected an error")
			}
			var carrier *notFoundError
			if !errors.As(err, &carrier) {
				t.Fatalf("got %T (%v), want *notFoundError", err, err)
			}
			if !errors.Is(err, ErrNotFound) {
				t.Fatalf("%v does not unwrap to ErrNotFound", err)
			}
			var invalid *ValidationError
			if !errors.As(err, &invalid) || invalid.Message == "" {
				t.Fatalf("%v carries no message, so the broker would answer an opaque 404", err)
			}
			if !contains(invalid.Message, site.want) {
				t.Fatalf("message %q does not contain %q", invalid.Message, site.want)
			}
		})
	}
}

// requireNotFoundInSource asserts that file builds a not-found carrying want
// through notFound(, which is the only check available for a site no caller
// can reach.
func requireNotFoundInSource(t *testing.T, file, want string) {
	t.Helper()
	body, err := os.ReadFile(filepath.Clean(file))
	if err != nil {
		t.Fatalf("read %s: %v", file, err)
	}
	if !strings.Contains(string(body), `notFound("", "`+want) {
		t.Fatalf("%s no longer builds %q with notFound(; a bare ErrNotFound there "+
			"reads as an opaque 404 and tells the caller nothing", file, want)
	}
}

// packageSource reads every non-test .go file of this package, keyed by name.
// It refuses a file carrying a NUL byte rather than scanning less of the
// package while still reporting success.
func packageSource(t *testing.T) map[string]string {
	t.Helper()
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read package directory: %v", err)
	}
	out := map[string]string{}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		body, readErr := os.ReadFile(filepath.Clean(name))
		if readErr != nil {
			t.Fatalf("read %s: %v", name, readErr)
		}
		if strings.ContainsRune(string(body), 0) {
			t.Fatalf("%s contains a NUL byte, so a text scan of this package cannot be trusted", name)
		}
		out[name] = string(body)
	}
	if len(out) == 0 {
		t.Fatalf("scanned no files; the scan itself is broken")
	}
	return out
}

// TestNotFoundSiteTableIsComplete stops the table above going quiet. A new
// notFound( call site that nobody classified fails here rather than shipping
// unclassified, which is the failure mode the two tests exist to prevent.
func TestNotFoundSiteTableIsComplete(t *testing.T) {
	source := packageSource(t)
	found := 0
	for _, text := range source {
		found += strings.Count(text, "notFound(") - strings.Count(text, "func notFound(")
	}
	if want := len(notFoundSites()); found != want {
		t.Fatalf("the package has %d notFound( call sites across %d files but the table lists %d; "+
			"classify the new site in notFoundSites()", found, len(source), want)
	}
}

// storeMethods is every method on Store. None of them is something a caller
// can invoke: a bot has data_link_records, data_update_record and the rest,
// and the operator has a button in the web UI. A Go method name in a message
// is an instruction neither of them can follow.
var storeMethods = []string{
	"CreateObjectTypes", "UpdateObjectType", "AddAttributes", "UpdateAttribute",
	"QueryRecords", "CreateRecords", "UpsertRecords", "UpdateRecord", "GetRecord",
	"PreviewDelete", "ExecuteDelete", "ListSpaces", "CreateSpace", "UpdateSpace",
	"GetSchema", "AttachApp", "DetachApp", "Unlink", "Link",
}

// TestMessagesDoNotNameStoreMethods sweeps the package for the failure this
// slice fixed: a message that tells the caller to call a Go method.
func TestMessagesDoNotNameStoreMethods(t *testing.T) {
	literal := regexp.MustCompile(`"(?:[^"\\]|\\.)*"`)
	method := regexp.MustCompile(`\b(` + strings.Join(storeMethods, "|") + `)\b`)
	// Interpreted SQL is written in backticks, so it is already out of scope;
	// this only guards the rare fragment that is not.
	sqlish := regexp.MustCompile(`\b(SELECT|FROM|INSERT|PRAGMA|CREATE TABLE|DELETE FROM)\b`)
	for name, text := range packageSource(t) {
		for _, quoted := range literal.FindAllString(text, -1) {
			body := quoted[1 : len(quoted)-1]
			// Only sentences reach a caller; identifiers, slugs, column names
			// and format fragments do not.
			if !strings.Contains(body, " ") || !strings.Contains(body, ".") {
				continue
			}
			if sqlish.MatchString(body) {
				continue
			}
			if hit := method.FindString(body); hit != "" {
				t.Errorf("%s: message %q names the Go method %q; say what the caller does, "+
					"not what the store calls it", name, body, hit)
			}
		}
	}
}
