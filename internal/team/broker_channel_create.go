package team

// Channel and DM creation: the canonical create path plus the DM endpoint.
//
// Split out of broker_office_channels.go, which had grown to 1573 lines and
// past the 1500-line budget. A pure move -- same package, same identifiers,
// no signature changed.
//
// Cohesive on purpose: with named channels and group DMs retiring behind
// reversible switches, "how does a room come into existence" is the question
// this file answers, and it is the one worth being able to open on its own.

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/nex-crm/wuphf/internal/channel"
)

// channelCreateInput is the input shape for createChannelLocked. It mirrors
// the bits of the POST /channels body that drive a "create" action so the
// Telegram-connect handler (and any future integration handler) can reuse the
// canonical create path without re-implementing the validation rules.
type channelCreateInput struct {
	Slug        string
	Name        string
	Description string
	Members     []string
	CreatedBy   string
	Surface     *channelSurface
}

// channelCreateError pairs an HTTP status with a user-facing message so the
// caller can write it back through http.Error without rebuilding the
// status-code → message mapping in every handler.
type channelCreateError struct {
	Code int
	Msg  string
}

func (e *channelCreateError) Error() string { return e.Msg }

// createChannelLocked is the canonical channel-create path. It validates the
// slug, applies the reserved-slug guard, validates members against
// b.findMemberLocked, prepends "ceo", optionally adds the creator, persists,
// and publishes the change event. Caller MUST hold b.mu.
//
// All of this used to be inlined in handleChannels' "create" case; pulling it
// out lets the Telegram-connect web flow share the exact same validation
// rather than reimplementing them and drifting (the original copy in
// handleTelegramConnect skipped member validation, the reserved-slug guard,
// and the creator-self-add — all silent gaps that this consolidation closes).
func (b *Broker) createChannelLocked(in channelCreateInput) (*teamChannel, *channelCreateError) {
	// Validate the raw slug before normalizing — normalizeChannelSlug rewrites
	// "" / whitespace to "general" and would have skipped the "slug required"
	// branch entirely, falling through to "channel already exists" because
	// #general always exists. Surface the missing-slug case as 400 with a
	// useful message instead.
	if strings.TrimSpace(in.Slug) == "" {
		return nil, &channelCreateError{Code: http.StatusBadRequest, Msg: "slug required"}
	}
	// The raw-emptiness guard immediately above is the real one. A second
	// `slug == ""` test after the normalise used to sit here and could never
	// fire, because normalizeChannelSlug returns "general" for empty input —
	// removed rather than left in place, since dead code that looks like a
	// guard invites the next reader to trust it.
	slug := normalizeChannelSlug(in.Slug)
	if reservedChannelSlugs[slug] {
		return nil, &channelCreateError{Code: http.StatusBadRequest, Msg: "slug is reserved"}
	}
	if b.findChannelLocked(slug) != nil {
		return nil, &channelCreateError{Code: http.StatusConflict, Msg: "channel already exists"}
	}

	requested := uniqueSlugs(in.Members)
	validated := make([]string, 0, len(requested))
	var missing []string
	for _, m := range requested {
		if b.findMemberLocked(m) == nil {
			missing = append(missing, m)
			continue
		}
		validated = append(validated, m)
	}
	if len(missing) > 0 {
		return nil, &channelCreateError{
			Code: http.StatusNotFound,
			Msg:  "unknown members: " + strings.Join(missing, ", "),
		}
	}

	final := append([]string{"ceo"}, validated...)
	// CreatedBy is an actor slug, not a channel slug. normalizeChannelSlug
	// rewrites "" to "general", which would silently auto-add a real office
	// member named "general" as a channel member whenever CreatedBy was
	// empty. normalizeActorSlug preserves "" so the guard below short-circuits.
	if creator := normalizeActorSlug(in.CreatedBy); creator != "" && creator != "ceo" && b.findMemberLocked(creator) != nil {
		final = append(final, creator)
	}

	now := time.Now().UTC().Format(time.RFC3339)
	ch := teamChannel{
		Slug:        slug,
		Name:        strings.TrimSpace(in.Name),
		Description: strings.TrimSpace(in.Description),
		Members:     uniqueSlugs(final),
		Surface:     in.Surface,
		CreatedBy:   strings.TrimSpace(in.CreatedBy),
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	if ch.Name == "" {
		ch.Name = slug
	}
	if ch.Description == "" {
		ch.Description = defaultTeamChannelDescription(ch.Slug, ch.Name)
	}
	b.channels = append(b.channels, ch)
	if err := b.saveLocked(); err != nil {
		// Roll back the in-memory append so a failed persist never leaves a
		// ghost channel (one with no owning task that the UI can't reach, and
		// that blocks a later create of the same slug with a phantom
		// StatusConflict). Without this, createPerTaskChannelLocked's caller
		// silently routes the task to #general instead of its own channel.
		b.channels = b.channels[:len(b.channels)-1]
		b.rebuildChannelIndexLocked()
		return nil, &channelCreateError{Code: http.StatusInternalServerError, Msg: "failed to persist broker state"}
	}
	b.publishOfficeChangeLocked(officeChangeEvent{Kind: "channel_created", Slug: slug})
	return &b.channels[len(b.channels)-1], nil
}

// handleCreateDM creates or returns an existing DM channel.
// POST /channels/dm — body: {members: ["human", "engineering"], type: "direct"|"group"}
func (b *Broker) handleCreateDM(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Members []string `json:"members"`
		Type    string   `json:"type"` // "direct" or "group"
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if len(body.Members) < 2 {
		http.Error(w, "at least 2 members required", http.StatusBadRequest)
		return
	}
	// Validate: at least one member must be "human" (no bot-to-bot DMs).
	hasHuman := false
	for _, m := range body.Members {
		if isHumanMessageSender(m) {
			hasHuman = true
			break
		}
	}
	if !hasHuman {
		http.Error(w, "DM must include a human member; bot-to-bot DMs are not allowed", http.StatusBadRequest)
		return
	}

	if b.channelStore == nil {
		http.Error(w, "channel store not initialized", http.StatusInternalServerError)
		return
	}

	var (
		ch      *channel.Channel
		err     error
		created bool
	)
	dmType := strings.TrimSpace(strings.ToLower(body.Type))
	// For group DMs, infer "created" from the group slug — the previous
	// FindDirectByMembers lookup checked for a 1:1 channel between the
	// first two members, which has no semantic relationship to whether
	// the group already existed.
	groupAlreadyExists := func(members []string) bool {
		slug := channel.GroupSlug(members)
		if slug == "" {
			return false
		}
		_, exists := b.channelStore.GetBySlug(slug)
		return exists
	}
	// Group DMs are retired (see groupDMsEnabled). Refuse BEFORE dispatching,
	// so both routes into a group are covered by one check: an explicit
	// type:"group", and the >2-members fallthrough below that silently
	// upgrades a "direct" request into a group. Requesting a group while it is
	// switched off is a conflict with the workspace's shape, not a malformed
	// request, so this is a 409 and the message says why.
	//
	// An EXISTING group is exempt: reopening one that is already on disk must
	// keep working, exactly as reading a pre-existing #general does.
	// Keyed on the member count alone, NOT on dmType. A type:"group" request
	// with only two members has always produced a plain 1:1 DM below, and it
	// still must — refusing it would reject a conversation that has exactly
	// the two participants the new model wants.
	wantsGroup := len(body.Members) > 2
	if wantsGroup && !groupDMsEnabled() && !groupAlreadyExists(body.Members) {
		http.Error(w,
			"group DMs are retired: a group DM is a channel by another name, and every conversation is now 1:1 with a single bot. Open a DM with one bot and tag the others in it.",
			http.StatusConflict)
		return
	}

	if dmType == "group" && len(body.Members) > 2 {
		created = !groupAlreadyExists(body.Members)
		ch, err = b.channelStore.GetOrCreateGroup(body.Members, "human")
	} else {
		// Default: direct (1:1). For >2 members use group.
		if len(body.Members) > 2 {
			created = !groupAlreadyExists(body.Members)
			ch, err = b.channelStore.GetOrCreateGroup(body.Members, "human")
		} else {
			// Normalize: find the non-human member for the slug.
			botSlug := ""
			for _, m := range body.Members {
				if !isHumanMessageSender(m) {
					botSlug = m
					break
				}
			}
			if botSlug == "" {
				http.Error(w, "could not determine bot member", http.StatusBadRequest)
				return
			}
			_, exists := b.channelStore.FindDirectByMembers("human", botSlug)
			created = !exists
			ch, err = b.channelStore.GetOrCreateDirect("human", botSlug)
		}
	}
	if err != nil {
		http.Error(w, "failed to create DM: "+err.Error(), http.StatusInternalServerError)
		return
	}

	b.mu.Lock()
	if b.findChannelLocked(ch.Slug) == nil {
		now := time.Now().UTC().Format(time.RFC3339)
		target := DMTargetBot(ch.Slug)
		description := "Group direct messages"
		memberSlugs := append([]string(nil), body.Members...)
		if target != "" {
			description = "Direct messages with " + target
			memberSlugs = []string{"human", target}
		}
		name := strings.TrimSpace(ch.Name)
		if name == "" {
			name = ch.Slug
		}
		b.channels = append(b.channels, teamChannel{
			Slug:        ch.Slug,
			Name:        name,
			Type:        "dm",
			Description: description,
			Members:     uniqueSlugs(memberSlugs),
			CreatedBy:   "human",
			CreatedAt:   now,
			UpdatedAt:   now,
		})
	}
	if err := b.saveLocked(); err != nil {
		b.mu.Unlock()
		http.Error(w, "failed to persist DM channel", http.StatusInternalServerError)
		return
	}
	b.mu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"id":      ch.ID,
		"slug":    ch.Slug,
		"type":    ch.Type,
		"name":    ch.Name,
		"created": created,
	})
}
