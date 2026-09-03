package team

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/nex-crm/wuphf/internal/config"
)

// POST /onboarding/reseed — give an already-onboarded office its founding team.
//
// Offices onboarded while the operator front door shipped completed the wizard
// with `bots: []`, which took the no-team seed path: a real workspace with
// #general and a company name, but zero teammates. Re-running onboarding is not
// an option (it is already complete), so those offices had no way back to a
// roster short of deleting the runtime home.
//
// This is that way back. It seeds the same fixed founding team the from-scratch
// wizard produces — CEO lead plus GTM Lead, Founding Engineer, Product Manager,
// Designer, with the built-in Librarian and App Builder back-filled — into the
// existing office.
//
// It deliberately does NOT reuse seedFromBlueprintLocked, even though that is
// the wizard's path: that function is a blank-slate seed and clears
// b.messages, b.tasks, and b.counter. Running it against a live team would
// delete the work already in it (an app build task and its channel, every
// message posted so far). This adds members and their channel memberships and
// touches nothing else.
//
// Narrow by design so it cannot become a general reset:
//   - 409 when the office already has ANY member. It only fills a vacuum; it
//     never merges into, reorders, or overwrites an existing roster.
//   - Existing channels keep their identity; the founding roster is added to
//     #general (and any blueprint channel that already exists) rather than
//     replacing the channel list.
func (b *Broker) handleOnboardingReseed(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	companyName := ""
	if cfg, err := config.Load(); err == nil {
		companyName = strings.TrimSpace(cfg.CompanyName)
	}
	if companyName == "" {
		companyName = "your company"
	}

	b.mu.Lock()
	if len(b.members) > 0 {
		count := len(b.members)
		b.mu.Unlock()
		writeJSON(w, http.StatusConflict, map[string]string{
			"error": fmt.Sprintf("this office already has %d member(s); reseed only fills an empty roster", count),
		})
		return
	}

	bp := scratchFoundingTeamBlueprint(companyName, "", "")
	members := blankSlateOfficeMembersFromBlueprint(bp, nil)
	if len(members) == 0 {
		b.mu.Unlock()
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "founding roster came back empty"})
		return
	}
	b.members = members
	b.rebuildMemberIndexLocked()

	// Put the new roster in the channels that already exist. Every teammate
	// belongs in #general; a blueprint channel that the office happens to
	// already have (e.g. #gtm) gets the members the blueprint assigns it.
	slugs := memberSlugsFromMembers(b.members)
	byBlueprint := map[string][]string{}
	for _, ch := range blankSlateOfficeChannelsFromBlueprint(bp, b.members) {
		byBlueprint[ch.Slug] = ch.Members
	}
	for i := range b.channels {
		switch {
		case b.channels[i].Slug == "general":
			b.channels[i].Members = slugs
		case byBlueprint[b.channels[i].Slug] != nil:
			b.channels[i].Members = byBlueprint[b.channels[i].Slug]
		}
	}

	seeded := len(b.members)
	err := b.saveLocked()
	b.mu.Unlock()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"seeded": seeded, "members": slugs})
}
