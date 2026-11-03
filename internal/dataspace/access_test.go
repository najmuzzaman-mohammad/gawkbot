package dataspace

import (
	"errors"
	"testing"
)

// accessKit is one space with enough schema and data that every Store method
// has something real to act on.
type accessKit struct {
	*kit
	thing, other string
	r1, r2, o1   string
	attrID       string
	token        string
}

func newAccessKit(t *testing.T) *accessKit {
	t.Helper()
	k := newKit(t)
	thing := k.typ("Thing")
	other := k.typ("Other")
	attr := k.attr(thing.ID, AttributeInput{Name: "Code", Type: TypeText, IsUnique: true})
	k.relate(thing.ID, "Other", other.ID, CardinalityManyToMany, "Things")
	r1 := k.create(thing.ID, map[string]any{"name": "One", "code": "a"}).ID
	r2 := k.create(thing.ID, map[string]any{"name": "Two", "code": "b"}).ID
	o1 := k.create(other.ID, map[string]any{"name": "Other one"}).ID
	preview, err := k.store.PreviewDelete(k.ctx, k.actor, k.spaceID, DeleteRecords, []string{r2})
	if err != nil {
		t.Fatalf("PreviewDelete: %v", err)
	}
	return &accessKit{
		kit: k, thing: thing.ID, other: other.ID,
		r1: r1, r2: r2, o1: o1, attrID: attr.ID, token: preview.Token,
	}
}

type storeCall struct {
	name  string
	write bool
	run   func(a *accessKit, actor Actor) error
}

func storeCalls() []storeCall {
	name := "Renamed"
	return []storeCall{
		{"GetSchema", false, func(a *accessKit, actor Actor) error {
			_, err := a.store.GetSchema(a.ctx, actor, a.spaceID)
			return err
		}},
		{"QueryRecords", false, func(a *accessKit, actor Actor) error {
			_, err := a.store.QueryRecords(a.ctx, actor, a.spaceID, Query{ObjectType: a.thing})
			return err
		}},
		{"GetRecord", false, func(a *accessKit, actor Actor) error {
			_, err := a.store.GetRecord(a.ctx, actor, a.spaceID, a.r1)
			return err
		}},
		// Description, not Name: renaming is owner-only, so it is not a
		// write-level call and belongs in TestOnlyOwnerRenamesASpace instead.
		{"UpdateSpace", true, func(a *accessKit, actor Actor) error {
			_, err := a.store.UpdateSpace(a.ctx, actor, a.spaceID, SpacePatch{Description: &name})
			return err
		}},
		{"CreateObjectTypes", true, func(a *accessKit, actor Actor) error {
			_, err := a.store.CreateObjectTypes(a.ctx, actor, a.spaceID,
				[]ObjectTypeInput{{Name: "Fresh"}})
			return err
		}},
		{"UpdateObjectType", true, func(a *accessKit, actor Actor) error {
			_, err := a.store.UpdateObjectType(a.ctx, actor, a.spaceID, a.thing,
				ObjectTypePatch{Description: &name})
			return err
		}},
		{"AddAttributes", true, func(a *accessKit, actor Actor) error {
			_, err := a.store.AddAttributes(a.ctx, actor, a.spaceID, a.thing,
				[]AttributeInput{{Name: "Memo", Type: TypeText}})
			return err
		}},
		{"UpdateAttribute", true, func(a *accessKit, actor Actor) error {
			_, err := a.store.UpdateAttribute(a.ctx, actor, a.spaceID, a.thing, a.attrID,
				AttributePatch{Description: &name})
			return err
		}},
		{"CreateRecords", true, func(a *accessKit, actor Actor) error {
			_, err := a.store.CreateRecords(a.ctx, actor, a.spaceID, a.thing,
				[]RecordInput{{Values: map[string]any{"name": "Three"}}})
			return err
		}},
		{"UpsertRecords", true, func(a *accessKit, actor Actor) error {
			_, err := a.store.UpsertRecords(a.ctx, actor, a.spaceID, a.thing, "code",
				[]RecordInput{{Values: map[string]any{"name": "Four", "code": "d"}}})
			return err
		}},
		{"UpdateRecord", true, func(a *accessKit, actor Actor) error {
			_, err := a.store.UpdateRecord(a.ctx, actor, a.spaceID, a.r1,
				map[string]any{"name": "One again"})
			return err
		}},
		{"Link", true, func(a *accessKit, actor Actor) error {
			_, err := a.store.Link(a.ctx, actor, a.spaceID,
				[]LinkInput{{Record: a.r1, Attribute: "other", Target: a.o1}})
			return err
		}},
		{"Unlink", true, func(a *accessKit, actor Actor) error {
			_, err := a.store.Unlink(a.ctx, actor, a.spaceID,
				[]LinkInput{{Record: a.r1, Attribute: "other", Target: a.o1}})
			return err
		}},
		{"PreviewDelete", true, func(a *accessKit, actor Actor) error {
			_, err := a.store.PreviewDelete(a.ctx, actor, a.spaceID, DeleteRecords, []string{a.r2})
			return err
		}},
		{"ExecuteDelete", true, func(a *accessKit, actor Actor) error {
			_, err := a.store.ExecuteDelete(a.ctx, actor, a.spaceID, a.token)
			return err
		}},
		{"AttachApp", true, func(a *accessKit, actor Actor) error {
			_, err := a.store.AttachApp(a.ctx, actor, a.spaceID, "app_00112233445566aa")
			return err
		}},
		{"DetachApp", true, func(a *accessKit, actor Actor) error {
			_, err := a.store.DetachApp(a.ctx, actor, a.spaceID, "app_00112233445566aa")
			return err
		}},
	}
}

func TestAccessEnforcedOnEveryMethod(t *testing.T) {
	scenarios := []struct {
		label  string
		access Access
		actor  Actor
		level  Level
	}{
		{"owner on a private space", Access{Scope: ScopePrivate}, testOwner, LevelWrite},
		{"operator on a private space", Access{Scope: ScopePrivate}, ActorHuman, LevelWrite},
		{"stranger on a private space", Access{Scope: ScopePrivate}, "ops", LevelNone},
		{"reader on a shared space",
			Access{Scope: ScopeShared, Grants: []Grant{{Bot: "ops", Level: LevelRead}}}, "ops", LevelRead},
		{"writer on a shared space",
			Access{Scope: ScopeShared, Grants: []Grant{{Bot: "ops", Level: LevelWrite}}}, "ops", LevelWrite},
		{"stranger on a shared space",
			Access{Scope: ScopeShared, Grants: []Grant{{Bot: "ops", Level: LevelRead}}}, "recruiter", LevelNone},
		{"any bot on a global space", Access{Scope: ScopeGlobal}, "hired-next-year", LevelWrite},
		{"empty actor", Access{Scope: ScopeGlobal}, "", LevelNone},
	}
	for _, scenario := range scenarios {
		// One fixture per scenario: the calls only assert which error kind came
		// back, so they can run in order against the same space.
		a := newAccessKit(t)
		if _, err := a.store.UpdateSpace(a.ctx, testOwner, a.spaceID,
			SpacePatch{Access: &scenario.access}); err != nil {
			t.Fatalf("UpdateSpace: %v", err)
		}
		for _, call := range storeCalls() {
			t.Run(scenario.label+"/"+call.name, func(t *testing.T) {
				err := call.run(a, scenario.actor)
				switch {
				case scenario.level == LevelNone:
					if !errors.Is(err, ErrNotFound) {
						t.Fatalf("%s: got %v, want ErrNotFound", call.name, err)
					}
					var forbidden *ForbiddenError
					if errors.As(err, &forbidden) {
						t.Fatalf("%s leaked the space's existence: %v", call.name, err)
					}
				case scenario.level == LevelRead && call.write:
					var forbidden *ForbiddenError
					if !errors.As(err, &forbidden) {
						t.Fatalf("%s: got %v, want *ForbiddenError", call.name, err)
					}
					if forbidden.Owner != string(testOwner) || forbidden.SpaceID != a.spaceID {
						t.Fatalf("forbidden error = %+v", forbidden)
					}
					if !errors.Is(err, ErrForbidden) {
						t.Fatalf("%s: ForbiddenError does not unwrap to ErrForbidden", call.name)
					}
				default:
					if err != nil {
						t.Fatalf("%s: unexpected error: %v", call.name, err)
					}
				}
			})
		}
	}
}

func TestListSpacesOnlyShowsVisibleOnes(t *testing.T) {
	k := newKit(t)
	shared, err := k.store.CreateSpace(k.ctx, testOwner, "Shared", "", Access{
		Scope: ScopeShared, Grants: []Grant{{Bot: "ops", Level: LevelRead}},
	})
	if err != nil {
		t.Fatalf("CreateSpace: %v", err)
	}
	global, err := k.store.CreateSpace(k.ctx, "recruiter", "Global", "", Access{Scope: ScopeGlobal})
	if err != nil {
		t.Fatalf("CreateSpace: %v", err)
	}

	cases := []struct {
		actor Actor
		want  map[string]Level
	}{
		{testOwner, map[string]Level{k.spaceID: LevelWrite, shared.ID: LevelWrite, global.ID: LevelWrite}},
		{ActorHuman, map[string]Level{k.spaceID: LevelWrite, shared.ID: LevelWrite, global.ID: LevelWrite}},
		{"ops", map[string]Level{shared.ID: LevelRead, global.ID: LevelWrite}},
		{"recruiter", map[string]Level{global.ID: LevelWrite}},
		{"", map[string]Level{}},
	}
	for _, tc := range cases {
		t.Run(string(tc.actor), func(t *testing.T) {
			spaces, listErr := k.store.ListSpaces(k.ctx, tc.actor)
			if listErr != nil {
				t.Fatalf("ListSpaces: %v", listErr)
			}
			if len(spaces) != len(tc.want) {
				t.Fatalf("saw %d spaces, want %d", len(spaces), len(tc.want))
			}
			for _, space := range spaces {
				want, ok := tc.want[space.ID]
				if !ok {
					t.Fatalf("space %s should not be visible", space.ID)
				}
				if space.CallerLevel != want {
					t.Fatalf("space %s level = %q, want %q", space.ID, space.CallerLevel, want)
				}
			}
		})
	}
}

func TestOnlyOwnerOrOperatorChangesAccess(t *testing.T) {
	k := newKit(t)
	writer := Access{Scope: ScopeShared, Grants: []Grant{{Bot: "ops", Level: LevelWrite}}}
	if _, err := k.store.UpdateSpace(k.ctx, testOwner, k.spaceID, SpacePatch{Access: &writer}); err != nil {
		t.Fatalf("UpdateSpace: %v", err)
	}
	description := "Described by a writer"
	if _, err := k.store.UpdateSpace(k.ctx, "ops", k.spaceID,
		SpacePatch{Description: &description}); err != nil {
		t.Fatalf("a writer could not describe: %v", err)
	}
	global := Access{Scope: ScopeGlobal}
	_, err := k.store.UpdateSpace(k.ctx, "ops", k.spaceID, SpacePatch{Access: &global})
	var forbidden *ForbiddenError
	if !errors.As(err, &forbidden) {
		t.Fatalf("a writer changed access: %v", err)
	}
	if space := k.space(); space.Access.Scope != ScopeShared {
		t.Fatalf("access changed anyway: %+v", space.Access)
	}
	if _, err := k.store.UpdateSpace(k.ctx, ActorHuman, k.spaceID, SpacePatch{Access: &global}); err != nil {
		t.Fatalf("the operator could not change access: %v", err)
	}
	if space := k.space(); space.Access.Scope != ScopeGlobal {
		t.Fatalf("operator change did not stick: %+v", space.Access)
	}
}

// TestOnlyOwnerRenamesASpace pins the split a write grant implies. Writing
// data into someone else's space is what the grant is for; relabelling it is
// not, and the owner has no way to notice it happened.
func TestOnlyOwnerRenamesASpace(t *testing.T) {
	k := newKit(t)
	writer := Access{Scope: ScopeShared, Grants: []Grant{{Bot: "ops", Level: LevelWrite}}}
	if _, err := k.store.UpdateSpace(k.ctx, testOwner, k.spaceID, SpacePatch{Access: &writer}); err != nil {
		t.Fatalf("UpdateSpace: %v", err)
	}
	name := "Renamed by a writer"
	_, err := k.store.UpdateSpace(k.ctx, "ops", k.spaceID, SpacePatch{Name: &name})
	var forbidden *ForbiddenError
	if !errors.As(err, &forbidden) {
		t.Fatalf("a writer renamed another bot's space: %v", err)
	}
	if !contains(forbidden.Error(), "renaming a data space is the owner's call") ||
		!contains(forbidden.Error(), "@cos") {
		t.Fatalf("refusal = %q", forbidden.Error())
	}
	if k.space().Name != "Test space" {
		t.Fatalf("the name changed anyway: %q", k.space().Name)
	}
	// The description is still a write-level change, and so is attaching an
	// app: that is how a collaborator's app reaches shared data.
	description := "Described by a writer"
	if _, err := k.store.UpdateSpace(k.ctx, "ops", k.spaceID,
		SpacePatch{Description: &description}); err != nil {
		t.Fatalf("a writer could not describe: %v", err)
	}
	if _, err := k.store.AttachApp(k.ctx, "ops", k.spaceID, "app_0123456789abcdef"); err != nil {
		t.Fatalf("a writer could not attach an app: %v", err)
	}
	// The owner and the operator rename freely.
	if _, err := k.store.UpdateSpace(k.ctx, testOwner, k.spaceID, SpacePatch{Name: &name}); err != nil {
		t.Fatalf("the owner could not rename: %v", err)
	}
	operatorName := "Renamed by the operator"
	if _, err := k.store.UpdateSpace(k.ctx, ActorHuman, k.spaceID,
		SpacePatch{Name: &operatorName}); err != nil {
		t.Fatalf("the operator could not rename: %v", err)
	}
	if k.space().Name != operatorName {
		t.Fatalf("name = %q", k.space().Name)
	}
}

func TestAccessNormalizationOnUpdate(t *testing.T) {
	k := newKit(t)
	access := Access{Scope: ScopeShared, Grants: []Grant{
		{Bot: " Recruiter ", Level: LevelRead},
		{Bot: "cos", Level: LevelRead},
		{Bot: "ops", Level: LevelWrite},
		{Bot: "RECRUITER", Level: LevelWrite},
	}}
	updated, err := k.store.UpdateSpace(k.ctx, testOwner, k.spaceID, SpacePatch{Access: &access})
	if err != nil {
		t.Fatalf("UpdateSpace: %v", err)
	}
	want := []Grant{{Bot: "ops", Level: LevelWrite}, {Bot: "recruiter", Level: LevelWrite}}
	if updated.Access.Scope != ScopeShared || len(updated.Access.Grants) != 2 {
		t.Fatalf("access = %+v", updated.Access)
	}
	for index, grant := range updated.Access.Grants {
		if grant != want[index] {
			t.Fatalf("grant %d = %+v, want %+v", index, grant, want[index])
		}
	}

	// A rejected access leaves the space exactly as it was.
	before := k.space()
	bad := Access{Scope: ScopeShared, Grants: []Grant{{Bot: "Ops Bot", Level: LevelRead}}}
	_, err = k.store.UpdateSpace(k.ctx, testOwner, k.spaceID, SpacePatch{Access: &bad})
	requireValidation(t, err, "is not a valid bot slug")
	after := k.space()
	if after.UpdatedAt != before.UpdatedAt || len(after.Access.Grants) != 2 {
		t.Fatalf("a rejected access changed the space: %+v", after)
	}

	empty := Access{Scope: ScopeShared}
	updated, err = k.store.UpdateSpace(k.ctx, testOwner, k.spaceID, SpacePatch{Access: &empty})
	if err != nil {
		t.Fatalf("UpdateSpace: %v", err)
	}
	if updated.Access.Scope != ScopePrivate || len(updated.Access.Grants) != 0 {
		t.Fatalf("shared with nobody = %+v", updated.Access)
	}
}

func TestCreateSpaceTakesAnyAccess(t *testing.T) {
	k := newKit(t)
	space, err := k.store.CreateSpace(k.ctx, "ops", "Office wide", "Everything",
		Access{Scope: ScopeGlobal, Grants: []Grant{{Bot: "cos", Level: LevelRead}}})
	if err != nil {
		t.Fatalf("CreateSpace: %v", err)
	}
	if space.Owner != "ops" || space.Access.Scope != ScopeGlobal || len(space.Access.Grants) != 0 {
		t.Fatalf("space = %+v", space)
	}
	if space.CallerLevel != LevelWrite || !IsSpaceID(space.ID) {
		t.Fatalf("space = %+v", space)
	}
	if _, err := k.store.CreateSpace(k.ctx, "ops", "  ", "", Access{}); err == nil {
		t.Fatalf("an unnamed space was created")
	}
	_, err = k.store.CreateSpace(k.ctx, "Not A Slug", "x", "", Access{})
	requireValidation(t, err, "is not a valid bot slug")
}

func TestAttachAndDetachApp(t *testing.T) {
	k := newKit(t)
	appID := "app_0123456789abcdef"
	space, err := k.store.AttachApp(k.ctx, testOwner, k.spaceID, appID)
	if err != nil {
		t.Fatalf("AttachApp: %v", err)
	}
	if !equalStrings(space.AttachedAppIDs, []string{appID}) {
		t.Fatalf("attached = %v", space.AttachedAppIDs)
	}
	again, err := k.store.AttachApp(k.ctx, testOwner, k.spaceID, appID)
	if err != nil {
		t.Fatalf("AttachApp twice: %v", err)
	}
	if !equalStrings(again.AttachedAppIDs, []string{appID}) {
		t.Fatalf("attaching twice duplicated: %v", again.AttachedAppIDs)
	}
	detached, err := k.store.DetachApp(k.ctx, testOwner, k.spaceID, appID)
	if err != nil {
		t.Fatalf("DetachApp: %v", err)
	}
	if len(detached.AttachedAppIDs) != 0 {
		t.Fatalf("attached = %v", detached.AttachedAppIDs)
	}
	_, err = k.store.AttachApp(k.ctx, testOwner, k.spaceID, "not-an-app")
	requireValidation(t, err, "is not an app id")
}

func TestUnknownSpaceReadsAsNotFound(t *testing.T) {
	k := newKit(t)
	if _, err := k.store.GetSchema(k.ctx, testOwner, "space_ffffffffffffffff"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("GetSchema = %v, want ErrNotFound", err)
	}
}

// TestMissingIDsAreBothValidationAndNotFound pins the two contracts that meet
// on an unknown id: the message names what was missing, and errors.Is finds
// ErrNotFound so the broker can answer 404.
func TestMissingIDsAreBothValidationAndNotFound(t *testing.T) {
	a := newAccessKit(t)
	cases := []struct {
		name string
		run  func() error
		want string
	}{
		{"record", func() error {
			_, err := a.store.GetRecord(a.ctx, a.actor, a.spaceID, "rec_nope")
			return err
		}, "Unknown record"},
		{"object type", func() error {
			_, err := a.store.QueryRecords(a.ctx, a.actor, a.spaceID, Query{ObjectType: "type_nope"})
			return err
		}, "Unknown object type"},
		{"attribute", func() error {
			name := "x"
			_, err := a.store.UpdateAttribute(a.ctx, a.actor, a.spaceID, a.thing, "attr_nope",
				AttributePatch{Name: &name})
			return err
		}, "has no attribute"},
		{"delete id", func() error {
			_, err := a.store.PreviewDelete(a.ctx, a.actor, a.spaceID, DeleteRecords, []string{"rec_nope"})
			return err
		}, "Unknown record ids"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.run()
			requireValidation(t, err, tc.want)
			if !errors.Is(err, ErrNotFound) {
				t.Fatalf("%v does not unwrap to ErrNotFound", err)
			}
		})
	}
}
