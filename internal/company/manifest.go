package company

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/nex-crm/wuphf/internal/channel"
	"github.com/nex-crm/wuphf/internal/config"
	"github.com/nex-crm/wuphf/internal/provider"
)

// The lead bot is the Chief of Staff. The SLUG stays "ceo" on purpose.
//
// The slug is an identifier, not a label: it appears in DM slugs
// ("ceo__human"), task owners, channel membership, and saved rosters on
// users' disks. Renaming it would orphan every one of those rows for anyone
// with an existing workspace, in exchange for changing a string nobody sees.
// The same reasoning applies to the other bot slugs.
//
// So the identifier is frozen and the display name is free to change. Anything
// a person reads comes from Name/Role; anything the system keys on uses Slug.
const (
	chiefOfStaffName = "Chief of Staff"
	chiefOfStaffRole = "Chief of Staff"
)

// generalChannelSlug aliases channel.GeneralSlug for use inside this file.
// Several loops here bind a range variable named `channel`, which shadows the
// package identifier; the alias keeps those bodies able to name the slug.
const generalChannelSlug = channel.GeneralSlug

// manifestUpdateMu serializes load → mutate → save sequences against the
// manifest file. Two callers that both Load + append + Save can otherwise
// race: each reads the same file, each mutates locally, and whichever Save
// wins drops the loser's mutation. Use UpdateManifest from any code that
// needs to add or modify entries; bare Load/Save callers (read-only or
// full-rewrite) don't need the lock and are unchanged.
var manifestUpdateMu sync.Mutex

// UpdateManifest atomically reads the manifest from disk, applies the
// caller's mutation, and writes the result back. Concurrent callers see a
// serialized order, so an append-then-save sequence cannot lose entries.
//
// The mutation callback receives a pointer; mutate the manifest in place and
// return nil to commit, or return an error to abort the save. If LoadManifest
// fails for any reason other than "file does not exist", UpdateManifest
// surfaces that error rather than silently starting from DefaultManifest —
// silently overwriting a corrupted manifest hides the real problem.
func UpdateManifest(mutate func(*Manifest) error) (err error) {
	manifestUpdateMu.Lock()
	defer manifestUpdateMu.Unlock()
	// Recover so a panic from inside `mutate` doesn't take down the whole
	// process — important when this is called from an HTTP handler goroutine
	// (the round-2 commit added /telegram/connect as one such caller). Re-
	// surface as an error so the caller can return a 500 instead of crashing.
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("UpdateManifest: panic in mutate: %v", r)
		}
	}()

	manifest, loadErr := LoadManifest()
	if loadErr != nil {
		return loadErr
	}
	if err := mutate(&manifest); err != nil {
		return err
	}
	return SaveManifest(manifest)
}

// SnapshotManifest returns the current on-disk manifest under the same lock
// UpdateManifest uses, so a caller that only reads (e.g. to derive a member
// set from manifest.Members) sees a consistent snapshot relative to any
// concurrent UpdateManifest writer. Falls back to DefaultManifest if the
// file doesn't exist; surfaces other errors.
func SnapshotManifest() (Manifest, error) {
	manifestUpdateMu.Lock()
	defer manifestUpdateMu.Unlock()
	return LoadManifest()
}

type MemberSpec struct {
	Slug         string                   `json:"slug"`
	Name         string                   `json:"name"`
	Role         string                   `json:"role,omitempty"`
	Expertise    []string                 `json:"expertise,omitempty"`
	Personality  string                   `json:"personality,omitempty"`
	AllowedTools []string                 `json:"allowed_tools,omitempty"`
	System       bool                     `json:"system,omitempty"`
	Provider     provider.ProviderBinding `json:"provider,omitempty"`
}

type ChannelSurfaceSpec struct {
	Provider    string `json:"provider,omitempty"`
	RemoteID    string `json:"remote_id,omitempty"`
	RemoteTitle string `json:"remote_title,omitempty"`
	Mode        string `json:"mode,omitempty"`
	BotTokenEnv string `json:"bot_token_env,omitempty"`
}

type BlueprintRef struct {
	Kind   string `json:"kind,omitempty"`
	ID     string `json:"id,omitempty"`
	Source string `json:"source,omitempty"`
}

type ChannelSpec struct {
	Slug        string              `json:"slug"`
	Name        string              `json:"name,omitempty"`
	Description string              `json:"description,omitempty"`
	Members     []string            `json:"members,omitempty"`
	Disabled    []string            `json:"disabled,omitempty"`
	Surface     *ChannelSurfaceSpec `json:"surface,omitempty"`
}

type Manifest struct {
	Name          string         `json:"name,omitempty"`
	Description   string         `json:"description,omitempty"`
	Lead          string         `json:"lead,omitempty"`
	Members       []MemberSpec   `json:"members,omitempty"`
	Channels      []ChannelSpec  `json:"channels,omitempty"`
	BlueprintRefs []BlueprintRef `json:"blueprint_refs,omitempty"`
	UpdatedAt     string         `json:"updated_at,omitempty"`
}

func (m Manifest) ActiveBlueprintRefs() []BlueprintRef {
	return normalizeBlueprintRefs(m.BlueprintRefs)
}

func (m Manifest) PrimaryBlueprintRef() (BlueprintRef, bool) {
	refs := m.ActiveBlueprintRefs()
	if len(refs) == 0 {
		return BlueprintRef{}, false
	}
	return refs[0], true
}

func (m Manifest) BlueprintRefsByKind(kind string) []BlueprintRef {
	kind = normalizeBlueprintKind(kind)
	refs := m.ActiveBlueprintRefs()
	if kind == "" {
		return refs
	}
	out := make([]BlueprintRef, 0, len(refs))
	for _, ref := range refs {
		if ref.Kind == kind {
			out = append(out, ref)
		}
	}
	return out
}

func ManifestPath() string {
	if path := strings.TrimSpace(os.Getenv("WUPHF_COMPANY_FILE")); path != "" {
		return path
	}
	if path := strings.TrimSpace(os.Getenv("NEX_COMPANY_FILE")); path != "" {
		return path
	}

	if strings.TrimSpace(os.Getenv("WUPHF_RUNTIME_HOME")) == "" {
		if cwd, err := os.Getwd(); err == nil {
			local := filepath.Join(cwd, "wuphf.company.json")
			if _, err := os.Stat(local); err == nil {
				return local
			}
		}
	}

	home := config.RuntimeHomeDir()
	if home == "" {
		return filepath.Join(".wuphf", "company.json")
	}
	return filepath.Join(home, ".wuphf", "company.json")
}

func LoadManifest() (Manifest, error) {
	path := ManifestPath()
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			manifest := DefaultManifest()
			return manifest, nil
		}
		return Manifest{}, err
	}
	var manifest Manifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return Manifest{}, err
	}
	manifest = backfillFromConfig(manifest)
	manifest = normalizeManifest(manifest)
	return manifest, nil
}

// backfillFromConfig fills empty manifest Name/Description from config
// so onboarding answers flow into the company manifest.
func backfillFromConfig(manifest Manifest) Manifest {
	cfg, _ := config.Load()
	if strings.TrimSpace(manifest.Name) == "" || manifest.Name == "Your gawkbot team" {
		if name := strings.TrimSpace(cfg.CompanyName); name != "" {
			manifest.Name = name
		}
	}
	if strings.TrimSpace(manifest.Description) == "" || strings.Contains(strings.ToLower(manifest.Description), "founding team") {
		if desc := strings.TrimSpace(cfg.CompanyDescription); desc != "" {
			manifest.Description = desc
		} else {
			manifest.Description = "Autonomous bot team runtime."
		}
	}
	if len(normalizeBlueprintRefs(manifest.BlueprintRefs)) == 0 {
		if blueprint := strings.TrimSpace(cfg.ActiveBlueprint()); blueprint != "" {
			manifest.BlueprintRefs = []BlueprintRef{{
				Kind:   "operation",
				ID:     normalizeSlug(blueprint),
				Source: "config",
			}}
		}
	}
	return manifest
}

func SaveManifest(manifest Manifest) error {
	manifest = normalizeManifest(manifest)
	manifest.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	path := ManifestPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return os.WriteFile(path, data, 0o600)
}

// AppBuilderSlug is the canonical slug of the built-in App Builder bot — the
// special teammate that turns repeatable workflows into Apps (internal tools).
// It is seeded into every office (see ensureAppBuilderMember) and is immutable
// like the CEO.
const AppBuilderSlug = "app-builder"

func DefaultManifest() Manifest {
	now := time.Now().UTC().Format(time.RFC3339)
	cfg, _ := config.Load()
	if launchFromScratchRequested() {
		return normalizeManifest(fromScratchDefaultManifest(now))
	}
	blueprintID := normalizeSlug(cfg.ActiveBlueprint())
	manifest := Manifest{
		Name:        "Your gawkbot team",
		Description: "Autonomous bot team runtime.",
		Lead:        "ceo",
		UpdatedAt:   now,
	}
	if blueprintID != "" {
		manifest.BlueprintRefs = []BlueprintRef{{
			Kind:   "operation",
			ID:     blueprintID,
			Source: "config",
		}}
		if resolved, ok := MaterializeManifest(manifest, repoRootFromCWD()); ok {
			resolved.UpdatedAt = now
			return normalizeManifest(resolved)
		}
	}
	// The default roster is the Chief of Staff alone. It used to be six: the
	// lead plus an App Builder, a Librarian, and a planner/executor/reviewer
	// trio. The founder retired all five as defaults — "that concept should
	// now be gone with those bots as default. their defintions also shouldn't
	// exist" — because a new user's first run should show the smallest system
	// that produces a trustworthy output: one bot that introduces itself,
	// asks the goal, and plans the first thing. Specialists are created on
	// demand, not preinstalled. App building and wiki contribution are system
	// skills every bot carries, not bots of their own.
	manifest.Members = []MemberSpec{
		{Slug: "ceo", Name: chiefOfStaffName, Role: chiefOfStaffRole, System: true},
	}
	// #general kill switch, gate 3b of 7. See internal/channel/general.go.
	if channel.GeneralEnabled() {
		generalMembers := make([]string, 0, len(manifest.Members))
		for _, member := range manifest.Members {
			generalMembers = append(generalMembers, member.Slug)
		}
		manifest.Channels = []ChannelSpec{{
			Slug:        generalChannelSlug,
			Name:        generalChannelSlug,
			Description: "The default company-wide room for top-level coordination, announcements, and cross-functional discussion.",
			Members:     generalMembers,
		}}
	}
	return normalizeManifest(manifest)
}

func launchFromScratchRequested() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("WUPHF_START_FROM_SCRATCH"))) {
	case "1", "true", "yes":
		return true
	default:
		return false
	}
}

func fromScratchDefaultManifest(now string) Manifest {
	// Same principle as the default manifest above: the smallest office that
	// works is the Chief of Staff alone. The old founder/operator/app-builder/
	// builder/reviewer set was an invented team of default specialists, which
	// the founder retired.
	members := []MemberSpec{
		{Slug: "ceo", Name: chiefOfStaffName, Role: chiefOfStaffRole, System: true},
	}
	channelMembers := make([]string, 0, len(members))
	for _, member := range members {
		channelMembers = append(channelMembers, member.Slug)
	}
	// #general kill switch, gate 3a of 7. See internal/channel/general.go.
	var channels []ChannelSpec
	if channel.GeneralEnabled() {
		channels = []ChannelSpec{{
			Slug:        generalChannelSlug,
			Name:        generalChannelSlug,
			Description: "Primary room for inventing and operating the business from scratch.",
			Members:     channelMembers,
		}}
	}
	return Manifest{
		Name:        "WUPHF Office",
		Description: "Autonomous office runtime that starts from a directive instead of a saved blueprint.",
		Lead:        "founder",
		Members:     members,
		Channels:    channels,
		UpdatedAt:   now,
	}
}

func normalizeManifest(manifest Manifest) Manifest {
	if strings.TrimSpace(manifest.Name) == "" {
		manifest.Name = "Your gawkbot team"
	}
	if strings.TrimSpace(manifest.Lead) == "" {
		manifest.Lead = "ceo"
	}
	manifest.BlueprintRefs = normalizeBlueprintRefs(manifest.BlueprintRefs)

	seenMembers := make(map[string]struct{}, len(manifest.Members))
	members := make([]MemberSpec, 0, len(manifest.Members))
	for _, member := range manifest.Members {
		member.Slug = normalizeSlug(member.Slug)
		if member.Slug == "" {
			continue
		}
		if _, ok := seenMembers[member.Slug]; ok {
			continue
		}
		seenMembers[member.Slug] = struct{}{}
		member.Name = strings.TrimSpace(member.Name)
		if member.Name == "" {
			member.Name = humanizeSlug(member.Slug)
		}
		member.Role = strings.TrimSpace(member.Role)
		if member.Role == "" {
			member.Role = member.Name
		}
		member.Expertise = normalizeStrings(member.Expertise)
		member.AllowedTools = normalizeStrings(member.AllowedTools)
		member.System = member.Slug == manifest.Lead || member.Slug == "ceo" || member.System
		members = append(members, member)
	}
	if len(members) == 0 {
		if resolved, ok := MaterializeManifest(manifest, repoRootFromCWD()); ok {
			return resolved
		}
		return DefaultManifest()
	}
	// Guarantee the built-in App Builder exists in every office — including
	// blueprint-materialized ones — and back-fill it for existing offices on
	// load. Appended last so it never displaces the lead or a blueprint roster.
	manifest.Members = members

	seenChannels := make(map[string]struct{}, len(manifest.Channels))
	channels := make([]ChannelSpec, 0, len(manifest.Channels))
	generalEnabled := channel.GeneralEnabled()
	for _, channel := range manifest.Channels {
		channel.Slug = normalizeSlug(channel.Slug)
		if channel.Slug == "" {
			continue
		}
		// #general kill switch, gate 3c of 7. A manifest.yaml on disk can
		// declare general directly, reaching here without passing through
		// DefaultManifest or fromScratchDefaultManifest.
		if !generalEnabled && channel.Slug == generalChannelSlug {
			continue
		}
		if _, ok := seenChannels[channel.Slug]; ok {
			continue
		}
		seenChannels[channel.Slug] = struct{}{}
		channel.Name = strings.TrimSpace(channel.Name)
		if channel.Name == "" {
			channel.Name = channel.Slug
		}
		channel.Description = strings.TrimSpace(channel.Description)
		if channel.Description == "" {
			channel.Description = defaultChannelDescription(channel.Slug, channel.Name)
		}
		channel.Members = normalizeSlugs(channel.Members)
		channel.Disabled = normalizeSlugs(channel.Disabled)
		channel.Members = ensureLeadMember(channel.Members, manifest.Lead)
		channel.Disabled = removeSlug(channel.Disabled, manifest.Lead)
		channels = append(channels, channel)
	}
	// #general kill switch, gate 3d of 7, and the load-bearing one in this
	// file: normalizeManifest runs on EVERY manifest, so this re-prepend would
	// undo gates 3a-3c on its own if it were left ungated.
	if generalEnabled && !containsChannel(channels, generalChannelSlug) {
		members := make([]string, 0, len(manifest.Members))
		for _, member := range manifest.Members {
			members = append(members, member.Slug)
		}
		channels = append([]ChannelSpec{{
			Slug:        generalChannelSlug,
			Name:        generalChannelSlug,
			Description: defaultChannelDescription(generalChannelSlug, generalChannelSlug),
			Members:     ensureLeadMember(members, manifest.Lead),
		}}, channels...)
	}
	manifest.Channels = channels
	return manifest
}

func normalizeBlueprintRefs(refs []BlueprintRef) []BlueprintRef {
	seen := make(map[string]struct{}, len(refs))
	out := make([]BlueprintRef, 0, len(refs))
	for _, ref := range refs {
		ref.Kind = normalizeBlueprintKind(ref.Kind)
		ref.ID = normalizeSlug(ref.ID)
		ref.Source = strings.ToLower(strings.TrimSpace(ref.Source))
		if ref.Source == "" {
			ref.Source = "manifest"
		}
		if ref.ID == "" {
			continue
		}
		key := ref.Kind + "|" + ref.ID + "|" + ref.Source
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, ref)
	}
	return out
}

func normalizeBlueprintKind(kind string) string {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "", "operation", "business", "template":
		return "operation"
	case "employee", "role":
		return "employee"
	default:
		return normalizeSlug(kind)
	}
}

func containsChannel(channels []ChannelSpec, slug string) bool {
	for _, channel := range channels {
		if channel.Slug == slug {
			return true
		}
	}
	return false
}

func defaultChannelDescription(slug, name string) string {
	if strings.TrimSpace(slug) == "" {
		slug = strings.TrimSpace(name)
	}
	switch normalizeSlug(slug) {
	case "general":
		return "The default company-wide room for top-level coordination, announcements, and cross-functional discussion."
	default:
		label := strings.TrimSpace(name)
		if label == "" {
			label = humanizeSlug(slug)
		}
		return label + " focused work. Use this channel for discussion, decisions, and execution specific to that stream."
	}
}

func ensureLeadMember(members []string, lead string) []string {
	lead = normalizeSlug(lead)
	if lead == "" {
		lead = "ceo"
	}
	if containsSlug(members, lead) {
		return normalizeSlugs(members)
	}
	return append([]string{lead}, normalizeSlugs(members)...)
}

func removeSlug(items []string, slug string) []string {
	slug = normalizeSlug(slug)
	var out []string
	for _, item := range normalizeSlugs(items) {
		if item != slug {
			out = append(out, item)
		}
	}
	return out
}

func containsSlug(items []string, want string) bool {
	want = normalizeSlug(want)
	for _, item := range normalizeSlugs(items) {
		if item == want {
			return true
		}
	}
	return false
}

func normalizeStrings(items []string) []string {
	seen := make(map[string]struct{}, len(items))
	out := make([]string, 0, len(items))
	for _, item := range items {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if _, ok := seen[item]; ok {
			continue
		}
		seen[item] = struct{}{}
		out = append(out, item)
	}
	return out
}

func normalizeSlugs(items []string) []string {
	seen := make(map[string]struct{}, len(items))
	out := make([]string, 0, len(items))
	for _, item := range items {
		item = normalizeSlug(item)
		if item == "" {
			continue
		}
		if _, ok := seen[item]; ok {
			continue
		}
		seen[item] = struct{}{}
		out = append(out, item)
	}
	return out
}

func normalizeSlug(input string) string {
	slug := strings.ToLower(strings.TrimSpace(input))
	slug = strings.ReplaceAll(slug, " ", "-")
	slug = strings.ReplaceAll(slug, "_", "-")
	return slug
}

func humanizeSlug(slug string) string {
	parts := strings.Split(strings.ReplaceAll(strings.TrimSpace(slug), "-", " "), " ")
	for i, part := range parts {
		if part == "" {
			continue
		}
		parts[i] = strings.ToUpper(part[:1]) + part[1:]
	}
	return strings.Join(parts, " ")
}

// ChiefOfStaffName and ChiefOfStaffRole expose the lead's display strings to
// other packages, so the name lives in exactly one place.
func ChiefOfStaffName() string { return chiefOfStaffName }
func ChiefOfStaffRole() string { return chiefOfStaffRole }
