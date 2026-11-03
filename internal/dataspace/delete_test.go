package dataspace

import (
	"errors"
	"testing"
	"time"
)

// deleteKit is the fixture the mock's delete tests use: three types, two
// relationships, five records and four links.
type deleteKit struct {
	*kit
	firm, investor, meeting string
	email, firmRel          Attribute
	f1, i1, i2, m1, m2      string
}

func newDeleteKit(t *testing.T) *deleteKit {
	t.Helper()
	k := newKit(t)
	firm := k.typ("Firm")
	investor := k.typ("Investor")
	meeting := k.typ("Meeting")
	email := k.attr(investor.ID, AttributeInput{Name: "Email", Type: TypeEmail})
	firmRel := k.relate(investor.ID, "Firm", firm.ID, CardinalityManyToOne, "Investors")
	k.relate(meeting.ID, "Investor", investor.ID, CardinalityManyToOne, "Meetings")

	f1 := k.create(firm.ID, map[string]any{"name": "Tidewrack"}).ID
	i1 := k.create(investor.ID, map[string]any{"name": "Mirela", "email": "m@tidewrack.example"}).ID
	i2 := k.create(investor.ID, map[string]any{"name": "Tobias"}).ID
	m1 := k.create(meeting.ID, map[string]any{"name": "Intro call"}).ID
	m2 := k.create(meeting.ID, map[string]any{"name": "Pitch"}).ID
	k.mustLink(i1, "firm", f1, false)
	k.mustLink(i2, "firm", f1, false)
	k.mustLink(m1, "investor", i1, false)
	k.mustLink(m2, "investor", i1, false)
	return &deleteKit{
		kit: k, firm: firm.ID, investor: investor.ID, meeting: meeting.ID,
		email: email, firmRel: firmRel, f1: f1, i1: i1, i2: i2, m1: m1, m2: m2,
	}
}

func (d *deleteKit) preview(kind DeleteKind, ids ...string) (Preview, error) {
	return d.store.PreviewDelete(d.ctx, d.actor, d.spaceID, kind, ids)
}

func (d *deleteKit) mustPreview(kind DeleteKind, ids ...string) Preview {
	d.t.Helper()
	preview, err := d.preview(kind, ids...)
	if err != nil {
		d.t.Fatalf("PreviewDelete(%s): %v", kind, err)
	}
	return preview
}

func (d *deleteKit) execute(token string) (Impact, error) {
	return d.store.ExecuteDelete(d.ctx, d.actor, d.spaceID, token)
}

func TestPreviewCountsRecordImpact(t *testing.T) {
	d := newDeleteKit(t)
	preview := d.mustPreview(DeleteRecords, d.i1)
	if preview.Kind != DeleteRecords {
		t.Fatalf("kind = %q", preview.Kind)
	}
	want := Impact{Records: 1, Links: 3}
	if preview.Impact != want {
		t.Fatalf("impact = %+v, want %+v", preview.Impact, want)
	}
	if got := d.space().RecordCount; got != 5 {
		t.Fatalf("preview changed the data: %d records", got)
	}
	if preview.ExpiresAt == "" {
		t.Fatalf("preview has no expiry")
	}
}

func TestPreviewCountsAttributeImpact(t *testing.T) {
	d := newDeleteKit(t)
	value := d.mustPreview(DeleteAttribute, d.email.ID)
	if want := (Impact{Records: 1, Attributes: 1}); value.Impact != want {
		t.Fatalf("value attribute impact = %+v, want %+v", value.Impact, want)
	}
	rel := d.mustPreview(DeleteAttribute, d.firmRel.ID)
	if want := (Impact{Links: 2, Attributes: 2}); rel.Impact != want {
		t.Fatalf("relationship attribute impact = %+v, want %+v", rel.Impact, want)
	}
}

func TestPreviewCountsObjectTypeImpact(t *testing.T) {
	d := newDeleteKit(t)
	preview := d.mustPreview(DeleteObjectType, d.investor)
	// Investor's own 4 attributes, plus Firm.investors and Meeting.investor.
	want := Impact{Records: 2, Links: 4, Attributes: 6, ObjectTypes: 1}
	if preview.Impact != want {
		t.Fatalf("impact = %+v, want %+v", preview.Impact, want)
	}
}

func TestPreviewRefusals(t *testing.T) {
	d := newDeleteKit(t)
	primary := d.readType(d.firm).Attributes[0].ID
	_, err := d.preview(DeleteAttribute, primary)
	requireValidation(t, err, "primary attribute")

	_, err = d.preview(DeleteRecords, "rec_nope")
	requireValidation(t, err, "rec_nope")

	_, err = d.preview(DeleteObjectType, "type_nope")
	requireValidation(t, err, "type_nope")

	_, err = d.preview(DeleteAttribute, "attr_nope")
	requireValidation(t, err, "attr_nope")

	_, err = d.preview(DeleteRecords)
	requireValidation(t, err, "empty")

	_, err = d.preview(DeleteSpace, "other")
	requireValidation(t, err, "exactly the space id")

	_, err = d.preview(DeleteKind("everything"), d.i1)
	requireValidation(t, err, "cannot be deleted")
}

func TestExecuteTokenIsSingleUseAndSpaceBound(t *testing.T) {
	d := newDeleteKit(t)
	_, err := d.execute("del_nope")
	requireValidation(t, err, "Unknown delete token")

	preview := d.mustPreview(DeleteRecords, d.m2)
	if _, err := d.store.ExecuteDelete(d.ctx, d.actor, "space_other", preview.Token); err == nil {
		t.Fatalf("a token worked on another space")
	}
	if _, err := d.execute(preview.Token); err != nil {
		t.Fatalf("ExecuteDelete: %v", err)
	}
	_, err = d.execute(preview.Token)
	requireValidation(t, err, "Unknown delete token")
}

func TestExecuteExpiry(t *testing.T) {
	d := newDeleteKit(t)
	preview := d.mustPreview(DeleteRecords, d.m2)
	d.clock.advance(DeleteTokenTTL + time.Second)
	_, err := d.execute(preview.Token)
	requireValidation(t, err, "expired")
	if got := d.readType(d.meeting).RecordCount; got != 2 {
		t.Fatalf("an expired token still deleted: %d records left", got)
	}

	inside := d.mustPreview(DeleteRecords, d.m2)
	d.clock.advance(DeleteTokenTTL - 5*time.Second)
	if _, err := d.execute(inside.Token); err != nil {
		t.Fatalf("just inside the window: %v", err)
	}
}

func TestTokenBindsToTheIDSet(t *testing.T) {
	d := newDeleteKit(t)
	preview := d.mustPreview(DeleteRecords, d.m2, d.m1, d.m2)
	if preview.Impact.Records != 2 {
		t.Fatalf("impact = %+v", preview.Impact)
	}
	if _, err := d.execute(preview.Token); err != nil {
		t.Fatalf("ExecuteDelete: %v", err)
	}
	if got := d.readType(d.meeting).RecordCount; got != 0 {
		t.Fatalf("records left = %d", got)
	}
}

func TestDeleteRecordsRemovesLinksFromTheOtherSide(t *testing.T) {
	d := newDeleteKit(t)
	preview := d.mustPreview(DeleteRecords, d.i1)
	impact, err := d.execute(preview.Token)
	if err != nil {
		t.Fatalf("ExecuteDelete: %v", err)
	}
	if impact != preview.Impact {
		t.Fatalf("impact = %+v, want %+v", impact, preview.Impact)
	}
	if !equalStrings(d.linkNames(d.f1, "investors"), []string{"Tobias"}) {
		t.Fatalf("firm links = %v", d.linkNames(d.f1, "investors"))
	}
	if len(d.linkNames(d.m1, "investor")) != 0 {
		t.Fatalf("meeting still links to a deleted record")
	}
	if got := d.readType(d.investor).RecordCount; got != 1 {
		t.Fatalf("investors left = %d", got)
	}
	if got := d.space().RecordCount; got != 4 {
		t.Fatalf("space records = %d", got)
	}
	if _, err := d.store.GetRecord(d.ctx, d.actor, d.spaceID, d.i1); err == nil {
		t.Fatalf("deleted record still readable")
	}
}

func TestDeleteValueAttributeRemovesItsValues(t *testing.T) {
	d := newDeleteKit(t)
	preview := d.mustPreview(DeleteAttribute, d.email.ID)
	if _, err := d.execute(preview.Token); err != nil {
		t.Fatalf("ExecuteDelete: %v", err)
	}
	record := d.record(d.i1)
	if len(record.Values) != 1 || record.Values["name"] != "Mirela" {
		t.Fatalf("values = %#v", record.Values)
	}
	if !equalStrings(d.attrSlugs(d.investor), []string{"name", "firm", "meetings"}) {
		t.Fatalf("slugs = %v", d.attrSlugs(d.investor))
	}
}

func TestDeleteRelationshipAttributeRemovesTheMirrorAndLinks(t *testing.T) {
	d := newDeleteKit(t)
	var mirror string
	for _, attr := range d.readType(d.firm).Attributes {
		if attr.Slug == "investors" {
			mirror = attr.ID
		}
	}
	preview := d.mustPreview(DeleteAttribute, mirror)
	if _, err := d.execute(preview.Token); err != nil {
		t.Fatalf("ExecuteDelete: %v", err)
	}
	if !equalStrings(d.attrSlugs(d.firm), []string{"name"}) {
		t.Fatalf("firm slugs = %v", d.attrSlugs(d.firm))
	}
	if !equalStrings(d.attrSlugs(d.investor), []string{"name", "email", "meetings"}) {
		t.Fatalf("investor slugs = %v", d.attrSlugs(d.investor))
	}
	record := d.record(d.i1)
	if len(record.Links) != 1 || len(record.Links["meetings"]) != 2 {
		t.Fatalf("links = %#v", record.Links)
	}
}

func TestDeleteObjectTypeCascades(t *testing.T) {
	d := newDeleteKit(t)
	preview := d.mustPreview(DeleteObjectType, d.investor)
	if _, err := d.execute(preview.Token); err != nil {
		t.Fatalf("ExecuteDelete: %v", err)
	}
	schema := d.schema()
	names := []string{}
	for _, entry := range schema.ObjectTypes {
		names = append(names, entry.Name)
		for _, attr := range entry.Attributes {
			if attr.Relationship != nil {
				t.Fatalf("%s.%s still points at a relationship", entry.Name, attr.Slug)
			}
		}
	}
	if !equalStrings(names, []string{"Firm", "Meeting"}) {
		t.Fatalf("types = %v", names)
	}
	if schema.Space.ObjectTypeCount != 2 || schema.Space.RecordCount != 3 {
		t.Fatalf("space = %+v", schema.Space)
	}
	if len(schema.Relationships) != 0 {
		t.Fatalf("relationships left = %d", len(schema.Relationships))
	}
	if len(d.record(d.m1).Links) != 0 {
		t.Fatalf("meeting links = %#v", d.record(d.m1).Links)
	}
}

func TestDeleteRecordsOfTypeEmptiesWithoutRemoving(t *testing.T) {
	d := newDeleteKit(t)
	preview := d.mustPreview(DeleteRecordsOfType, d.meeting)
	if want := (Impact{Records: 2, Links: 2}); preview.Impact != want {
		t.Fatalf("impact = %+v, want %+v", preview.Impact, want)
	}
	if _, err := d.execute(preview.Token); err != nil {
		t.Fatalf("ExecuteDelete: %v", err)
	}
	entry := d.readType(d.meeting)
	if entry.RecordCount != 0 {
		t.Fatalf("records left = %d", entry.RecordCount)
	}
	if !equalStrings(d.attrSlugs(d.meeting), []string{"name", "investor"}) {
		t.Fatalf("the type lost attributes: %v", d.attrSlugs(d.meeting))
	}
	if len(d.linkNames(d.i1, "meetings")) != 0 {
		t.Fatalf("meeting links survived")
	}
}

func TestExecuteFailsWhenThePlanChanged(t *testing.T) {
	d := newDeleteKit(t)
	stale := d.mustPreview(DeleteRecords, d.m1)
	first := d.mustPreview(DeleteRecords, d.m1)
	if _, err := d.execute(first.Token); err != nil {
		t.Fatalf("ExecuteDelete: %v", err)
	}
	_, err := d.execute(stale.Token)
	requireValidation(t, err, "Unknown record ids")
}

func TestExecuteFailsWhenTheImpactGrew(t *testing.T) {
	d := newDeleteKit(t)
	preview := d.mustPreview(DeleteRecords, d.i2)
	// A new meeting linked to the same investor changes what the delete takes.
	m3 := d.create(d.meeting, map[string]any{"name": "Follow up"}).ID
	d.mustLink(m3, "investor", d.i2, false)
	_, err := d.execute(preview.Token)
	requireValidation(t, err, "Run the preview again")
	if got := d.readType(d.investor).RecordCount; got != 2 {
		t.Fatalf("the delete ran anyway: %d investors left", got)
	}
}

func TestDeleteSpaceRemovesEverything(t *testing.T) {
	d := newDeleteKit(t)
	preview := d.mustPreview(DeleteSpace, d.spaceID)
	want := Impact{Records: 5, Links: 4, Attributes: 8, ObjectTypes: 3}
	if preview.Impact != want {
		t.Fatalf("impact = %+v, want %+v", preview.Impact, want)
	}
	if _, err := d.execute(preview.Token); err != nil {
		t.Fatalf("ExecuteDelete: %v", err)
	}
	spaces, err := d.store.ListSpaces(d.ctx, d.actor)
	if err != nil {
		t.Fatalf("ListSpaces: %v", err)
	}
	if len(spaces) != 0 {
		t.Fatalf("spaces left = %+v", spaces)
	}
	if _, err := d.store.GetSchema(d.ctx, d.actor, d.spaceID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("GetSchema after delete = %v, want ErrNotFound", err)
	}
	if _, err := d.store.PreviewDelete(d.ctx, d.actor, d.spaceID, DeleteRecords, []string{d.i1}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("PreviewDelete after delete = %v, want ErrNotFound", err)
	}
}

// share puts the space into a shared scope with the given grants, as the owner.
func (d *deleteKit) share(grants ...Grant) {
	d.t.Helper()
	access := Access{Scope: ScopeShared, Grants: grants}
	if _, err := d.store.UpdateSpace(d.ctx, d.actor, d.spaceID, SpacePatch{Access: &access}); err != nil {
		d.t.Fatalf("UpdateSpace: %v", err)
	}
}

func requireForbidden(t *testing.T, err error, want string) *ForbiddenError {
	t.Helper()
	var forbidden *ForbiddenError
	if !errors.As(err, &forbidden) {
		t.Fatalf("expected *ForbiddenError containing %q, got %T: %v", want, err, err)
	}
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("%v does not unwrap to ErrForbidden", err)
	}
	if want != "" && !contains(forbidden.Error(), want) {
		t.Fatalf("error %q does not contain %q", forbidden.Error(), want)
	}
	return forbidden
}

// TestDeleteSpaceNeedsOwnership pins the one delete that write access does not
// buy. A bot granted write on someone else's space may empty every type in it,
// but removing the space itself — and the grant it is standing on — is the
// owner's call, and no grant implies it.
func TestDeleteSpaceNeedsOwnership(t *testing.T) {
	d := newDeleteKit(t)
	d.share(Grant{Bot: "ops", Level: LevelWrite}, Grant{Bot: "viewer", Level: LevelRead})

	// Preview is refused before anything is planned.
	_, err := d.store.PreviewDelete(d.ctx, "ops", d.spaceID, DeleteSpace, []string{d.spaceID})
	forbidden := requireForbidden(t, err, "deleting a data space is the owner's call")
	if !contains(forbidden.Error(), "@cos") || forbidden.Owner != string(testOwner) {
		t.Fatalf("the refusal does not name the owner: %+v (%v)", forbidden, err)
	}
	if forbidden.SpaceID != d.spaceID {
		t.Fatalf("forbidden error = %+v", forbidden)
	}
	_, err = d.store.PreviewDelete(d.ctx, "viewer", d.spaceID, DeleteSpace, []string{d.spaceID})
	requireForbidden(t, err, "read-only access")

	// A bot with no access learns nothing: not that the space exists, not who
	// owns it.
	_, err = d.store.PreviewDelete(d.ctx, "stranger", d.spaceID, DeleteSpace, []string{d.spaceID})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("a stranger got %v, want ErrNotFound", err)
	}
	var invalid *ValidationError
	if errors.As(err, &invalid) {
		t.Fatalf("a stranger was told %q", invalid.Message)
	}

	// Execute is refused too, on the owner's own token, and the refusal does
	// not burn it: the owner can still use it afterwards.
	preview := d.mustPreview(DeleteSpace, d.spaceID)
	_, err = d.store.ExecuteDelete(d.ctx, "ops", d.spaceID, preview.Token)
	requireForbidden(t, err, "deleting a data space is the owner's call")
	_, err = d.store.ExecuteDelete(d.ctx, "viewer", d.spaceID, preview.Token)
	requireForbidden(t, err, "read-only access")
	_, err = d.store.ExecuteDelete(d.ctx, "stranger", d.spaceID, preview.Token)
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("a stranger got %v, want ErrNotFound", err)
	}
	if got := d.space().RecordCount; got != 5 {
		t.Fatalf("a refused delete still ran: %d records", got)
	}
	if _, err := d.execute(preview.Token); err != nil {
		t.Fatalf("the owner's token did not survive the refusals: %v", err)
	}
	spaces, err := d.store.ListSpaces(d.ctx, d.actor)
	if err != nil {
		t.Fatalf("ListSpaces: %v", err)
	}
	if len(spaces) != 0 {
		t.Fatalf("spaces left = %+v", spaces)
	}
}

// TestDeleteSpaceAllowedForTheOperator: the human operator is not a bot with a
// grant, and is never refused.
func TestDeleteSpaceAllowedForTheOperator(t *testing.T) {
	d := newDeleteKit(t)
	preview, err := d.store.PreviewDelete(d.ctx, ActorHuman, d.spaceID, DeleteSpace, []string{d.spaceID})
	if err != nil {
		t.Fatalf("PreviewDelete as the operator: %v", err)
	}
	if _, err := d.store.ExecuteDelete(d.ctx, ActorHuman, d.spaceID, preview.Token); err != nil {
		t.Fatalf("ExecuteDelete as the operator: %v", err)
	}
	if _, err := d.store.GetSchema(d.ctx, d.actor, d.spaceID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("GetSchema after delete = %v, want ErrNotFound", err)
	}
}

// TestWriteGrantStillDeletesInsideTheSpace: the ownership gate is on the space
// kind only. Every other kind still asks for nothing more than write.
func TestWriteGrantStillDeletesInsideTheSpace(t *testing.T) {
	d := newDeleteKit(t)
	d.share(Grant{Bot: "ops", Level: LevelWrite})
	for _, kind := range []struct {
		kind DeleteKind
		ids  []string
	}{
		{DeleteRecords, []string{d.m2}},
		{DeleteRecordsOfType, []string{d.meeting}},
		{DeleteAttribute, []string{d.email.ID}},
		{DeleteObjectType, []string{d.investor}},
	} {
		preview, err := d.store.PreviewDelete(d.ctx, "ops", d.spaceID, kind.kind, kind.ids)
		if err != nil {
			t.Fatalf("PreviewDelete(%s) as a writer: %v", kind.kind, err)
		}
		if _, err := d.store.ExecuteDelete(d.ctx, "ops", d.spaceID, preview.Token); err != nil {
			t.Fatalf("ExecuteDelete(%s) as a writer: %v", kind.kind, err)
		}
	}
	if len(d.schema().ObjectTypes) != 2 {
		t.Fatalf("types left = %d", len(d.schema().ObjectTypes))
	}
}

func TestDeleteSpaceRemovesTheFile(t *testing.T) {
	d := newDeleteKit(t)
	preview := d.mustPreview(DeleteSpace, d.spaceID)
	if _, err := d.execute(preview.Token); err != nil {
		t.Fatalf("ExecuteDelete: %v", err)
	}
	next := d.reopen()
	spaces, err := next.store.ListSpaces(next.ctx, next.actor)
	if err != nil {
		t.Fatalf("ListSpaces: %v", err)
	}
	if len(spaces) != 0 {
		t.Fatalf("a deleted space came back: %+v", spaces)
	}
}
