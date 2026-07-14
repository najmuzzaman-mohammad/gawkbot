package team

import "testing"

func TestAppBuilderAccessIsLimitedToItsLinkedTaskChannel(t *testing.T) {
	b := &Broker{
		channels: []teamChannel{
			{Slug: "task-office-1", TaskID: "OFFICE-1"},
			{Slug: "task-office-2", TaskID: "OFFICE-2"},
			{Slug: "task-stale", TaskID: "OFFICE-3"},
			{Slug: "task-missing", TaskID: "OFFICE-404"},
			{Slug: "task-duplicate", TaskID: "OFFICE-DUP", Members: []string{appBuilderSlug}},
			{Slug: "task-member-only", Members: []string{appBuilderSlug}},
		},
		tasks: []teamTask{
			{ID: "OFFICE-1", Channel: "task-office-1", Owner: appBuilderSlug},
			{ID: "OFFICE-2", Channel: "task-office-2", Owner: "operator"},
			{ID: "OFFICE-3", Channel: "another-channel", Owner: appBuilderSlug},
			{ID: "OFFICE-DUP", Channel: "task-duplicate", Owner: appBuilderSlug},
			{ID: "OFFICE-DUP", Channel: "task-duplicate", Owner: appBuilderSlug},
		},
	}

	if !b.canAccessChannelLocked(appBuilderSlug, "task-office-1") {
		t.Fatal("App Builder must access the linked channel of a task it owns")
	}
	for _, channel := range []string{
		"task-office-2",
		"task-stale",
		"task-missing",
		"task-duplicate",
		"task-member-only",
		"general",
	} {
		if b.canAccessChannelLocked(appBuilderSlug, channel) {
			t.Fatalf("App Builder must not access unrelated channel %q", channel)
		}
	}
}

func TestAppBuilderTaskActionsStayOwnerScopedWithoutRoster(t *testing.T) {
	b := &Broker{tasks: []teamTask{
		{ID: "OFFICE-1", Owner: appBuilderSlug},
		{ID: "OFFICE-2", Owner: "operator"},
	}}

	for _, action := range []string{"comment", "complete", "reopen"} {
		if err := b.checkTaskActionAuthLocked(action, appBuilderSlug, "OFFICE-1"); err != nil {
			t.Fatalf("%s on owned task: %v", action, err)
		}
	}
	for _, tc := range []struct {
		action string
		id     string
	}{
		{action: "complete", id: "OFFICE-2"},
		{action: "reassign", id: "OFFICE-1"},
		{action: "approve", id: "OFFICE-1"},
		{action: "create"},
	} {
		if err := b.checkTaskActionAuthLocked(tc.action, appBuilderSlug, tc.id); err == nil {
			t.Fatalf("%s on %q must be denied", tc.action, tc.id)
		}
	}
}
