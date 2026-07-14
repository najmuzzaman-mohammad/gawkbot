package team

import "strings"

// checkAppBuilderTaskActionAuthLocked keeps the built-in App Builder on the
// same owner-only transition surface as a managed specialist. Operator
// workspaces can intentionally have no registered members or lead, so this
// check must run before the unregistered/no-lead compatibility fallthrough.
// Caller holds b.mu.
func (b *Broker) checkAppBuilderTaskActionAuthLocked(action, targetTaskID string) error {
	ownerAllowed := map[string]bool{
		"submit_for_review": true,
		"review":            true,
		"complete":          true,
		"resume":            true,
		"release":           true,
		"claim":             true,
		"assign":            true,
		"block":             true,
		"cancel":            true,
		"reopen":            true,
	}
	if ownerAllowed[action] && targetTaskID != "" {
		if task := b.findTaskByIDLocked(strings.TrimSpace(targetTaskID)); task != nil &&
			isAppBuilderSlug(task.Owner) {
			return nil
		}
	}
	return taskMutationError(
		TaskMutationForbidden,
		"App Builder can only update the status of an App Builder task it owns.",
		nil,
	)
}
