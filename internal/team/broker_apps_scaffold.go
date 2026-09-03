package team

// broker_apps_scaffold.go — pre-scaffold a new app the moment its build task is
// created, so the live preview boots a real running scaffold in seconds instead
// of showing minutes of "Building…" dead air.
//
// Both app-build entry points land here through MutateTask("create"):
//   - the explicit /create-app slash command (human → POST /tasks)
//   - the approved propose_app gate (broker → MutateTask in
//     maybeSpawnAppBuilderTaskFromProposal)
// Both format the title as "Build app: <name>" / "Create app: <name>", so a
// single hook covers them. "Improve"/"Update" titles are skipped — they already
// target an existing app the bot reads with get_app.

import (
	"fmt"
	"log"
	"regexp"
	"strings"
	"time"
)

// newAppBuildTitleRe matches a NEW-app build task title and captures the name.
// It deliberately excludes "improve"/"update" (those edit an existing app).
var newAppBuildTitleRe = regexp.MustCompile(`(?i)^\s*(?:build|create)\s+app:\s*(.+?)\s*$`)

// parseNewAppBuildTitle returns the app name when title is a NEW-app build task,
// or ("", false) otherwise.
func parseNewAppBuildTitle(title string) (string, bool) {
	m := newAppBuildTitleRe.FindStringSubmatch(title)
	if m == nil {
		return "", false
	}
	name := strings.TrimSpace(m[1])
	if name == "" {
		return "", false
	}
	return name, true
}

// maybePrescaffoldAppForCreate scaffolds the app for a new app-build task and
// appends a workspace brief (the pre-created app id + "publish with this id")
// to the task details. It is a cheap no-op for every non-app-builder create and
// degrades gracefully: any scaffold failure leaves the task untouched so the
// build still proceeds the old (slower) way rather than failing to start.
//
// Runs OUTSIDE b.mu (the app store has its own lock); callers invoke it before
// taking the broker lock.
func (b *Broker) maybePrescaffoldAppForCreate(action, channel string, body TaskPostRequest) TaskPostRequest {
	if !strings.EqualFold(strings.TrimSpace(action), "create") {
		return body
	}
	if !strings.EqualFold(strings.TrimSpace(body.Owner), appBuilderSlug) {
		return body
	}
	name, ok := parseNewAppBuildTitle(body.Title)
	if !ok {
		return body
	}
	// Already carries a workspace brief (e.g. a retried create) — don't append a
	// second one.
	if strings.Contains(body.Details, appWorkspaceBriefMarker) {
		return body
	}

	// Identity is (name, channel): re-issuing the same build continues the same
	// app instead of spawning a duplicate, and a deduped/retried create maps to
	// the same scaffold. No timestamp, so the id is stable across retries.
	slug := slugifyNotebookEntry(name)
	if slug == "" {
		slug = "app"
	}
	id := customAppID(slug, name, channel)
	// A PUBLISHED bot must never be handed to a new build. Identity is
	// (name, channel) and channel is still "general" at create time, so a
	// second workflow whose derived name matches an existing bot would be
	// told to publish OVER it (2026-08-16 VP-RevOps QA: the discount-desk
	// build was briefed to republish the live Pipeline Bot). Salt the id
	// until it is free or points at a resumable building leftover — that
	// keeps retry-of-the-same-build semantics without the hijack.
	for n := 2; ; n++ {
		existing, _, err := b.appStore().Get(id)
		if err != nil {
			break // id free
		}
		if existing.Status == customAppStatusBuilding {
			break // an unpublished leftover of this same build — resume it
		}
		id = customAppID(slug, name, fmt.Sprintf("%s#%d", channel, n))
	}

	actor := strings.TrimSpace(body.CreatedBy)
	if actor == "" {
		actor = appBuilderSlug
	}
	if _, err := b.appStore().Scaffold(id, name, "", actor, time.Now()); err != nil {
		// Pre-scaffold is an enhancement; never block task creation on it —
		// but never swallow it either: without the scaffold there is no
		// instant preview, no stable app id in the brief, and no edit
		// channel, which silently degrades the whole first build.
		log.Printf("apps: pre-scaffold %s failed (build continues without instant preview): %v", id, err)
		return body
	}

	body.Details = strings.TrimRight(body.Details, "\n") + "\n\n" + appWorkspaceBrief(id, b.appStore().SrcDir(id))
	return body
}

// appBuilderTaskAppIDRe extracts the app id an App Builder task targets from its
// details prose. BOTH entry points name the id in a stable, parseable form:
//   - a NEW-app build appends "register_app(app_id=app_xxxx)" (appWorkspaceBrief)
//   - an IMPROVE task carries "register_app (app_id=app_xxxx)" and/or
//     "Improve the existing app `app_xxxx`" (composeAppBrief / appBuilderTaskBrief)
//
// We match the register_app form (optional space + optional quotes) because it
// is present in every app-builder task and is the canonical id the bot
// publishes under. The capture is the validated 16-hex app id shape.
var appBuilderTaskAppIDRe = regexp.MustCompile(`register_app\s*\(\s*app_id\s*=\s*["'` + "`" + `]?(app_[0-9a-f]{16})`)

// parseAppBuilderTaskAppID returns the target app id named in an App Builder
// task's details, or ("", false) when none is present (e.g. a malformed brief).
func parseAppBuilderTaskAppID(details string) (string, bool) {
	m := appBuilderTaskAppIDRe.FindStringSubmatch(details)
	if m == nil {
		return "", false
	}
	return m[1], true
}

// appEditChannelPrefix marks a channel as an app's dedicated edit thread.
//
// ── Read this before extending anything here ─────────────────────────────────
//
// An `app-<appid>` thread IS a channel by construction: it is a row in
// b.channels created through createChannelLocked, with members, exactly like any
// other. That is worth stating plainly, because the product is moving the other
// way. #general is being retired and so are group DMs — the founder's reasoning
// is that a group DM is just a channel — leaving one human-visible surface: a
// 1:1 DM with a single bot. This thread is therefore the last multi-party room
// in the product, and it survives only because it is not a room anyone can find:
//
//   - It is INVISIBLE. It must never appear in a sidebar, channel list, picker,
//     switcher, search result, or the default /channels listing — absent from
//     the data those surfaces enumerate, not merely hidden with CSS. Today that
//     means the `app-` filter in web/src/components/sidebar/ChannelList.tsx
//     (alongside `task-`) and handleChannels' listing guard. Anything new that
//     enumerates channels has to skip it too.
//   - It is PLUMBING. Its entire job is to correlate an app with its build
//     conversation and give the Edit panel something to wake on. It is not
//     somewhere a human browses to.
//   - Its membership is MINIMAL by design: the App Builder, plus the CEO that
//     createChannelLocked prepends. Do not add more. The moment three bots are
//     talking in it, it is a channel in behaviour as well as in structure, and
//     it will be retired with the rest.
//
// The intended end state is different from this: you work on an app by DMing the
// App Builder and TAGGING the app for context, the same way tasks and wiki
// articles get tagged. The per-app thread then lives on the app record rather
// than in the channel system. This exists now because apps were BROKEN without
// it — every completed build was resolving to no app and being silently
// reopened (see ensureAppEditChannelLocked) — and fixing that was worth more
// than waiting for the DM model to land.
const appEditChannelPrefix = "app-"

// appEditChannelSlug is an app's edit-thread channel slug, derived from the APP
// id and nothing else.
//
// Deriving it from the app is the whole point. It used to be whatever channel
// the app's build task happened to land in, which the one-room change broke:
// every app-builder task now lands in #general, and #general cannot be an app's
// edit thread (every app would claim it, so appForEditChannel, appBuilderRunTaskID
// and appBuildChatSnippet could no longer tell one app's thread from another's,
// and the FE would mount the whole office chat inside every app's edit panel).
// One app, one slug, no ambiguity.
// App ids are already "app_<16 hex>", and normalizeChannelSlug rewrites "_" to
// "-", so prefixing naively would read "app-app-<hex>". The id's own prefix is
// dropped so the slug is "app-<hex>".
func appEditChannelSlug(appID string) string {
	appID = strings.TrimSpace(appID)
	if appID == "" {
		return ""
	}
	bare := strings.TrimPrefix(strings.TrimPrefix(appID, "app_"), "app-")
	if bare == "" {
		return ""
	}
	return normalizeChannelSlug(appEditChannelPrefix + bare)
}

// ensureAppEditChannelLocked mints the app's dedicated edit-thread channel and
// binds it to the app's manifest, returning the slug. Idempotent: an existing
// channel is reused and SetEditChannel no-ops when the value is unchanged, so a
// retried create never churns either side.
//
// Members are the App Builder (the only bot that works an app) plus the CEO,
// which createChannelLocked prepends. The Librarian is deliberately NOT seeded:
// an app's build log is machinery, not team knowledge.
//
// Returns "" when the app id is empty or the channel cannot be created; callers
// leave the app unbound in that case rather than falling back to a shared room.
// Caller MUST hold b.mu.
func (b *Broker) ensureAppEditChannelLocked(appID, appName string) string {
	slug := appEditChannelSlug(appID)
	if slug == "" {
		return ""
	}
	if b.findChannelLocked(slug) == nil {
		name := strings.TrimSpace(appName)
		if name == "" {
			name = slug
		}
		members := make([]string, 0, 1)
		if b.findMemberLocked(appBuilderSlug) != nil {
			members = append(members, appBuilderSlug)
		}
		if _, cerr := b.createChannelLocked(channelCreateInput{
			Slug:      slug,
			Name:      name,
			Members:   members,
			CreatedBy: appBuilderSlug,
		}); cerr != nil {
			// Never silent: without the channel the app has no edit thread and
			// the FE hides Edit forever, which is precisely the failure this
			// binding exists to prevent.
			log.Printf("apps: create edit channel %q for app %s failed (app stays un-editable): %s", slug, appID, cerr.Msg)
			return ""
		}
	}
	// Tolerate "not found": an improve task can reference an app that was deleted
	// between create and now; nothing to bind then.
	_ = b.appStore().SetEditChannel(appID, slug)
	return slug
}

// stampAppEditChannelForTaskLocked binds an App Builder task's target app to its
// dedicated `app-<appid>` edit thread and returns that slug, so the caller can
// route the task into it.
//
// It used to do the reverse — take the task's channel and stamp THAT onto the
// app — with a guard that skipped "general" because a note in the lobby would
// not wake the owner. The one-room change lands every app-builder task in
// #general, so that guard meant no app was ever bound: POST /apps/{id}/edit-session
// 500'd with "edit session created but no channel was bound" and the FE, which
// gates Edit on app.editChannel, hid Edit on every app. The direction is now
// inverted: the app owns the channel, and the task follows it.
//
// Best-effort for non-app work: a non-app-builder owner or a task whose details
// name no app id returns "" and the caller keeps the channel it already had.
// Caller MUST hold b.mu.
//
// The second parameter is the task's channel, which this no longer reads — the
// app owns the channel now, and the task follows it. It is kept only so the
// existing call site in broker_tasks_mutation_service.go still compiles; that
// call site should assign the returned slug to its `channel` variable and drop
// the argument.
func (b *Broker) stampAppEditChannelForTaskLocked(owner, details string) string {
	if !strings.EqualFold(strings.TrimSpace(owner), appBuilderSlug) {
		return ""
	}
	id, ok := parseAppBuilderTaskAppID(details)
	if !ok {
		return ""
	}
	name := ""
	if app, _, err := b.appStore().Get(id); err == nil {
		name = app.Name
	}
	return b.ensureAppEditChannelLocked(id, name)
}

// appWorkspaceBriefMarker is a stable sentinel so the brief is appended at most
// once per task.
const appWorkspaceBriefMarker = "App workspace ready:"

// appWorkspaceBrief is the instruction appended to a pre-scaffolded app's task:
// build your version, then publish with this exact id so the live preview and
// version history stay on one app.
func appWorkspaceBrief(id, srcDir string) string {
	return fmt.Sprintf(
		"%s a project for this app is already scaffolded and showing a LIVE preview as `%s`. "+
			"The project source lives at `%s` — work there directly (no searching for it, "+
			"no copying scaffolds). Build your version from the scaffold, then publish with "+
			"register_app(app_id=%s) — keep that exact id so the preview and version history "+
			"stay on this one app. Publish early and iterate; every register_app hot-reloads "+
			"the live preview.",
		appWorkspaceBriefMarker, id, srcDir, id,
	)
}
