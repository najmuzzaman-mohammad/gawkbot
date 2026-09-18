package dataspace

import "testing"

// One walkthrough per ICP tutorial example in docs/specs/agent-data-model.md,
// mirroring web/src/api/dataspaces.icp.test.ts. Steps that need the UI or the
// app bridge are covered as far as the data layer goes.

func TestICP1SeedRaiseTracker(t *testing.T) {
	k := newKit(t)

	// Step 1: the bot checks existing types, finds none, and creates three.
	if len(k.schema().ObjectTypes) != 0 {
		t.Fatalf("a fresh space is not empty")
	}
	result, err := k.store.CreateObjectTypes(k.ctx, k.actor, k.spaceID, []ObjectTypeInput{
		{Name: "Investor", Attributes: []AttributeInput{
			{Name: "Email", Type: TypeEmail, IsUnique: true},
			{Name: "Stage", Type: TypeStatus, Options: []string{"Intro", "Pitched", "Diligence", "Committed", "Passed"}},
			{Name: "Check size", Type: TypeCurrency},
		}},
		{Name: "Firm", Attributes: []AttributeInput{
			{Name: "Domain", Type: TypeText, IsUnique: true},
			{Name: "Tier", Type: TypeSelect, Options: []string{"Tier 1", "Tier 2"}},
		}},
		{Name: "Meeting", Attributes: []AttributeInput{
			{Name: "Date", Type: TypeDate},
			{Name: "Notes", Type: TypeText},
		}},
	})
	if err != nil {
		t.Fatalf("CreateObjectTypes: %v", err)
	}
	if result.Failed != 0 {
		t.Fatalf("CreateObjectTypes: %+v", result.Entries)
	}
	investor := result.Entries[0].ID
	firm := result.Entries[1].ID
	meeting := result.Entries[2].ID

	// Step 2: relationship fields, each with its inverse, in one call.
	relResult, err := k.store.AddAttributes(k.ctx, k.actor, k.spaceID, investor, []AttributeInput{
		{Name: "Firm", Type: TypeRelationship, Relationship: &RelationshipInput{
			Target: "Firm", Cardinality: CardinalityManyToOne, InverseName: "Investors",
		}},
	})
	if err != nil || relResult.Failed != 0 {
		t.Fatalf("AddAttributes(firm): %v %+v", err, relResult.Entries)
	}
	k.relate(meeting, "Investor", investor, CardinalityManyToOne, "Meetings")

	// Step 3: re-read the schema, then create records from the notes.
	plurals := []string{}
	for _, entry := range k.schema().ObjectTypes {
		plurals = append(plurals, entry.NamePlural)
	}
	if !equalStrings(plurals, []string{"Investors", "Firms", "Meetings"}) {
		t.Fatalf("plurals = %v", plurals)
	}
	if !equalStrings(k.attrSlugs(investor), []string{"name", "email", "stage", "check_size", "firm", "meetings"}) {
		t.Fatalf("investor slugs = %v", k.attrSlugs(investor))
	}

	tidewrack := k.create(firm, map[string]any{
		"name": "Tidewrack Capital", "domain": "tidewrack.example", "tier": "Tier 1",
	})
	notes := []map[string]any{
		{"name": "Mirela Okonjo-Hart", "email": "mirela@tidewrack.example", "stage": "Pitched", "check_size": 250000},
		{"name": "Tobias Vandersloot", "email": "tobias@tidewrack.example", "stage": "Intro"},
		{"name": "Anneke Brightwater", "email": "anneke@halcyonspur.example", "stage": "Committed", "check_size": 100000},
	}
	written, err := k.store.UpsertRecords(k.ctx, k.actor, k.spaceID, investor, "email",
		[]RecordInput{{Values: notes[0]}, {Values: notes[1]}, {Values: notes[2]}})
	if err != nil || written.Failed != 0 {
		t.Fatalf("UpsertRecords: %v %+v", err, written.Entries)
	}
	ids := []string{written.Entries[0].ID, written.Entries[1].ID, written.Entries[2].ID}
	k.mustLink(ids[0], "firm", tidewrack.ID, false)
	k.mustLink(ids[1], "firm", tidewrack.ID, false)

	// A second run does not duplicate: the unique email names the existing
	// record on a create, and updates it on an upsert.
	rerun := k.createError(investor, map[string]any{
		"name": "Mirela Okonjo-Hart", "email": "Mirela@Tidewrack.example",
	})
	if rerun.Attribute != "email" || !contains(rerun.Error, ids[0]) {
		t.Fatalf("rerun entry = %+v", rerun)
	}
	second, err := k.store.UpsertRecords(k.ctx, k.actor, k.spaceID, investor, "email",
		[]RecordInput{{Values: notes[0]}, {Values: notes[1]}, {Values: notes[2]}})
	if err != nil || second.Failed != 0 {
		t.Fatalf("second UpsertRecords: %v %+v", err, second.Entries)
	}
	k.update(ids[0], map[string]any{"stage": "Diligence"})
	if got := k.readType(investor).RecordCount; got != 3 {
		t.Fatalf("record count = %d, want 3", got)
	}

	for _, row := range []map[string]any{
		{"name": "Intro call", "date": "2026-07-02"},
		{"name": "Partner meeting", "date": "2026-08-11T16:00:00Z"},
	} {
		created := k.create(meeting, row)
		k.mustLink(created.ID, "investor", ids[0], false)
	}

	// Step 4: the Investors table sorted by stage, then the record page.
	page, err := k.store.QueryRecords(k.ctx, k.actor, k.spaceID, Query{
		ObjectType: investor, Sort: &Sort{Attribute: "stage"},
	})
	if err != nil {
		t.Fatalf("QueryRecords: %v", err)
	}
	names := []string{}
	for _, record := range page.Records {
		names = append(names, valueString(record.Values["name"]))
	}
	if !equalStrings(names, []string{"Tobias Vandersloot", "Mirela Okonjo-Hart", "Anneke Brightwater"}) {
		t.Fatalf("sorted names = %v", names)
	}
	if !equalStrings(k.linkNames(ids[0], "firm"), []string{"Tidewrack Capital"}) {
		t.Fatalf("firm link = %v", k.linkNames(ids[0], "firm"))
	}
	if !equalStrings(k.linkNames(ids[0], "meetings"), []string{"Intro call", "Partner meeting"}) {
		t.Fatalf("meeting links = %v", k.linkNames(ids[0], "meetings"))
	}

	// Step 5, data layer only: a stage change shows in the table query.
	k.update(ids[1], map[string]any{"stage": "Passed"})
	after, err := k.store.QueryRecords(k.ctx, k.actor, k.spaceID, Query{
		ObjectType: investor,
		Filters:    []Filter{{Attribute: "stage", Operator: OpEquals, Value: "Passed"}},
	})
	if err != nil {
		t.Fatalf("QueryRecords: %v", err)
	}
	if len(after.Records) != 1 || after.Records[0].ID != ids[1] {
		t.Fatalf("filtered = %+v", after.Records)
	}
}

func TestICP2ClientDeliveryTracker(t *testing.T) {
	k := newKit(t)

	// Step 1.
	client := k.typ("Client")
	project := k.typ("Project")
	k.attr(project.ID, AttributeInput{Name: "Status", Type: TypeStatus})
	k.attr(project.ID, AttributeInput{Name: "Budget", Type: TypeCurrency})
	k.relate(project.ID, "Client", client.ID, CardinalityManyToOne, "Projects")
	deliverable := k.typ("Deliverable")
	k.attr(deliverable.ID, AttributeInput{Name: "Due date", Type: TypeDate})
	k.attr(deliverable.ID, AttributeInput{Name: "Done", Type: TypeToggle})
	k.attr(deliverable.ID, AttributeInput{Name: "Owner", Type: TypeText})
	k.relate(deliverable.ID, "Project", project.ID, CardinalityManyToOne, "Deliverables")

	larkspur := k.create(client.ID, map[string]any{"name": "Larkspur Dental Group"})
	rebuild := k.create(project.ID, map[string]any{
		"name": "Patient booking flow redesign", "status": "In progress", "budget": "48000",
	})
	k.mustLink(rebuild.ID, "client", larkspur.ID, false)
	copyDeck := k.create(deliverable.ID, map[string]any{
		"name": "Copy deck", "due_date": "2026-10-01", "done": false, "owner": "Priya",
	})
	k.mustLink(copyDeck.ID, "project", rebuild.ID, false)

	// Step 2: the inline due date edit persists and shows under the project.
	edited := k.update(copyDeck.ID, map[string]any{"due_date": "2026-10-15"})
	if edited.Values["due_date"] != "2026-10-15" {
		t.Fatalf("due date = %v", edited.Values["due_date"])
	}
	projectPage := k.record(rebuild.ID)
	if len(projectPage.Links["deliverables"]) != 1 ||
		projectPage.Links["deliverables"][0].ID != copyDeck.ID {
		t.Fatalf("deliverables = %+v", projectPage.Links["deliverables"])
	}
	related := k.record(projectPage.Links["deliverables"][0].ID)
	if related.Values["due_date"] != "2026-10-15" {
		t.Fatalf("related due date = %v", related.Values["due_date"])
	}

	// Step 3: one select attribute on the existing type; no second type.
	requireEntryError(t, k.typeError(ObjectTypeInput{Name: "deliverable"}), "Add attributes to it instead")
	priority := k.attr(deliverable.ID, AttributeInput{
		Name: "Priority", Type: TypeSelect, Options: []string{"low", "medium", "high"},
	})
	seen := 0
	for _, entry := range k.schema().ObjectTypes {
		if entry.Name == "Deliverable" {
			seen++
		}
	}
	if seen != 1 {
		t.Fatalf("Deliverable exists %d times", seen)
	}

	// Step 4: "urgent" is refused with the valid options; the bot maps to high.
	_, err := k.store.UpdateRecord(k.ctx, k.actor, k.spaceID, copyDeck.ID,
		map[string]any{"priority": "urgent"})
	invalid := requireValidation(t, err, "")
	want := `"urgent" is not a valid option for Priority. Valid options: low, medium, high.`
	if invalid.Message != want {
		t.Fatalf("message = %q, want %q", invalid.Message, want)
	}
	mapped := k.update(copyDeck.ID, map[string]any{"priority": "high"})
	if mapped.Values["priority"] != priority.Options[2].ID {
		t.Fatalf("priority = %v", mapped.Values["priority"])
	}
}

func TestICP3RecruitingPipeline(t *testing.T) {
	k := newKit(t)
	// The other use cases of the office live next door, in their own spaces.
	neighbor, err := k.store.CreateSpace(k.ctx, "recruiter", "Someone else's space", "", Access{Scope: ScopeGlobal})
	if err != nil {
		t.Fatalf("CreateSpace: %v", err)
	}
	neighborType, err := k.store.CreateObjectTypes(k.ctx, "recruiter", neighbor.ID,
		[]ObjectTypeInput{{Name: "Interview"}})
	if err != nil || neighborType.Failed != 0 {
		t.Fatalf("neighbor CreateObjectTypes: %v", err)
	}

	// Step 1.
	role := k.typ("Role")
	candidate := k.typ("Candidate")
	k.attr(candidate.ID, AttributeInput{Name: "Email", Type: TypeEmail, IsUnique: true})
	k.attr(candidate.ID, AttributeInput{Name: "Stage", Type: TypeStatus})
	k.relate(candidate.ID, "Role", role.ID, CardinalityManyToOne, "Candidates")
	interview := k.typ("Interview")
	k.attr(interview.ID, AttributeInput{Name: "Date", Type: TypeDate})
	k.attr(interview.ID, AttributeInput{Name: "Rating", Type: TypeRating})
	k.attr(interview.ID, AttributeInput{Name: "Interviewer", Type: TypeText})
	k.relate(interview.ID, "Candidate", candidate.ID, CardinalityManyToOne, "Interviews")

	roleIDs := []string{}
	for _, name := range []string{"Senior Backend Engineer", "Product Designer", "Customer Success Lead"} {
		roleIDs = append(roleIDs, k.create(role.ID, map[string]any{"name": name}).ID)
	}
	freya := k.create(candidate.ID, map[string]any{
		"name": "Freya Lindahl", "email": "freya.lindahl@postbox.example", "stage": "To do",
	})
	k.mustLink(freya.ID, "role", roleIDs[0], false)

	// Step 2: rating 7 is rejected clearly; 4 is fine.
	tooHigh := k.createError(interview.ID, map[string]any{"name": "Onsite panel", "rating": 7})
	if tooHigh.Error != "Rating must be a whole number from 1 to 5; got 7." {
		t.Fatalf("rating error = %q", tooHigh.Error)
	}
	onsite := k.create(interview.ID, map[string]any{
		"name": "Onsite panel", "date": "2026-09-03", "rating": 4, "interviewer": "Dana Whitlock-Ames",
	})
	k.mustLink(onsite.ID, "candidate", freya.ID, false)

	// A candidate cannot be on two roles; replace moves them.
	requireEntryError(t, k.link(freya.ID, "role", roleIDs[1], false),
		"Freya Lindahl is already linked to Senior Backend Engineer")
	k.mustLink(freya.ID, "role", roleIDs[1], true)
	if !equalStrings(k.linkNames(freya.ID, "role"), []string{"Product Designer"}) {
		t.Fatalf("role = %v", k.linkNames(freya.ID, "role"))
	}
	if len(k.linkNames(roleIDs[0], "candidates")) != 0 {
		t.Fatalf("the old role kept the candidate")
	}

	// Step 3: the preview shows counts, and nothing goes until execute.
	preview, err := k.store.PreviewDelete(k.ctx, k.actor, k.spaceID, DeleteObjectType, []string{interview.ID})
	if err != nil {
		t.Fatalf("PreviewDelete: %v", err)
	}
	want := Impact{Records: 1, Links: 1, Attributes: 6, ObjectTypes: 1}
	if preview.Impact != want {
		t.Fatalf("impact = %+v, want %+v", preview.Impact, want)
	}
	if len(k.schema().ObjectTypes) != 3 {
		t.Fatalf("the preview removed something")
	}
	if _, err := k.store.ExecuteDelete(k.ctx, k.actor, k.spaceID, preview.Token); err != nil {
		t.Fatalf("ExecuteDelete: %v", err)
	}
	names := []string{}
	for _, entry := range k.schema().ObjectTypes {
		names = append(names, entry.Name)
	}
	if !equalStrings(names, []string{"Role", "Candidate"}) {
		t.Fatalf("types = %v", names)
	}
	if !equalStrings(k.attrSlugs(candidate.ID), []string{"name", "email", "stage", "role"}) {
		t.Fatalf("candidate slugs = %v", k.attrSlugs(candidate.ID))
	}

	// Step 4: the use case lives in its own space; the neighbor is untouched.
	neighborSchema, err := k.store.GetSchema(k.ctx, "recruiter", neighbor.ID)
	if err != nil {
		t.Fatalf("neighbor GetSchema: %v", err)
	}
	if len(neighborSchema.ObjectTypes) != 1 || neighborSchema.ObjectTypes[0].Name != "Interview" {
		t.Fatalf("neighbor types = %+v", neighborSchema.ObjectTypes)
	}
	if _, err := k.store.GetRecord(k.ctx, ActorHuman, neighbor.ID, freya.ID); err == nil {
		t.Fatalf("a record leaked across spaces")
	}
}
