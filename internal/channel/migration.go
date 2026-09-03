// internal/channel/migration.go
package channel

import (
	"strings"

	"github.com/google/uuid"
)

// MigrateLegacyDM migrates channels from the old dm-* prefix format to the new
// Mattermost-aligned format with proper ChannelType and deterministic slugs.
//
// Rules:
//   - dm-{bot} channels: Type→D, Slug→DirectSlug("human", bot), UUID assigned, members created
//   - channels with empty Type and no dm- prefix: Type→O, UUID assigned if missing
//   - channels already with UUIDs and proper types: unchanged
//
// Returns true if any migration occurred. Idempotent: safe to call on startup.
func (s *Store) MigrateLegacyDM() bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	changed := false

	for i := range s.channels {
		ch := &s.channels[i]

		isDMSlug := strings.HasPrefix(ch.Slug, "dm-")
		hasProperType := ch.Type == ChannelTypeDirect || ch.Type == ChannelTypeGroup || ch.Type == ChannelTypePublic
		hasUUID := ch.ID != ""

		if hasProperType && hasUUID {
			// Already migrated — skip
			continue
		}

		if isDMSlug {
			// Extract bot slug: "dm-engineering" → "engineering"
			botSlug := strings.TrimPrefix(ch.Slug, "dm-")
			newSlug := DirectSlug("human", botSlug)
			oldSlug := ch.Slug

			ch.ID = uuid.NewString()
			ch.Type = ChannelTypeDirect
			ch.Slug = newSlug
			if ch.UpdatedAt == "" {
				ch.UpdatedAt = now()
			}

			// Rewrite message channel references
			for j := range s.messages {
				if s.messages[j].Channel == oldSlug {
					s.messages[j].Channel = newSlug
				}
			}

			// Create members for this DM
			s.addMemberLocked(ch.ID, "human", "all")
			s.addMemberLocked(ch.ID, botSlug, "all")

			changed = true
		} else {
			// Public channel — assign UUID and type if missing
			if ch.ID == "" {
				ch.ID = uuid.NewString()
				changed = true
			}
			if ch.Type == "" {
				ch.Type = ChannelTypePublic
				changed = true
			}
		}
	}

	if changed {
		s.rebuildIndexes()
	}

	return changed
}

// MigrateDMSlugString converts an old dm-* slug to the new deterministic pair slug.
// Non-DM slugs are returned unchanged. Used by broker to migrate task/request channel refs.
func MigrateDMSlugString(slug string) string {
	if strings.HasPrefix(slug, "dm-") {
		botSlug := strings.TrimPrefix(slug, "dm-")
		return DirectSlug("human", botSlug)
	}
	return slug
}
