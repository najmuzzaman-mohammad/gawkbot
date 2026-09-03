package team

// broker_decision_packet_events.go owns the five net-new manifest events
// the multi-bot control loop emits across the lifecycle. They register
// in the existing PR #729 HeadlessEvent taxonomy (manifest type) so the
// frontend's existing event-stream consumer renders them without a
// parallel pipeline.
//
// Events in this file:
//
//   - artifact.ready    — owner bot committed a session report (running → review)
//   - review.submitted  — one reviewer bot recorded a grade
//   - decision.required — convergence rule fired (review → decision)
//   - decision.recorded — human merge / request-changes / block / defer
//   - spec.created      — emitted by Lane B's intake driver when SetSpec lands
//
// All five carry a typed sub-event tag in HeadlessEvent.Detail so a
// frontend doing a string switch can branch without looking at internal
// fields. The Type stays HeadlessEventTypeManifest to keep the wire-shape
// compatible with PR #729's manifest consumer.

import (
	"encoding/json"
	"strings"
	"time"
)

// LifecycleManifestSubKind labels the five lifecycle-bound manifest
// events emitted by the Decision Packet layer. Frontend consumers branch
// on this string to distinguish lifecycle events from per-turn manifests.
type LifecycleManifestSubKind string

const (
	LifecycleManifestSpecCreated      LifecycleManifestSubKind = "spec.created"
	LifecycleManifestArtifactReady    LifecycleManifestSubKind = "artifact.ready"
	LifecycleManifestReviewSubmitted  LifecycleManifestSubKind = "review.submitted"
	LifecycleManifestDecisionRequired LifecycleManifestSubKind = "decision.required"
	LifecycleManifestDecisionRecorded LifecycleManifestSubKind = "decision.recorded"
)

// lifecycleManifestPayload is the JSON-encoded body the broker stamps
// into HeadlessEvent.Detail for every lifecycle manifest. The Subkind
// is the discriminator the frontend reads first; ReviewerSlug is set
// only on review.submitted; Action is set only on decision.recorded;
// ActorSlug is set on decision.recorded so the post-merge audit log
// knows which authenticated reviewer pushed the button.
type lifecycleManifestPayload struct {
	Subkind        LifecycleManifestSubKind `json:"subkind"`
	TaskID         string                   `json:"taskId"`
	LifecycleState LifecycleState           `json:"lifecycleState,omitempty"`
	ReviewerSlug   string                   `json:"reviewerSlug,omitempty"`
	Severity       Severity                 `json:"severity,omitempty"`
	Action         string                   `json:"action,omitempty"`
	ActorSlug      string                   `json:"actorSlug,omitempty"`
	Reason         string                   `json:"reason,omitempty"`
	EmittedAt      time.Time                `json:"emittedAt"`
}

// lifecycleManifestStreamSlug is the synthetic bot slug used for
// stream-bucket attribution of lifecycle manifests. Real bot streams
// are keyed by member slug; lifecycle events are broker-authored, so we
// pick a stable reserved slug the frontend can filter on.
const lifecycleManifestStreamSlug = "system.lifecycle"

// emitLifecycleManifestLocked stamps a HeadlessEventTypeManifest event
// into the per-task bot stream buffer (if one exists for the task).
// Caller must hold b.mu — the botStreams map is broker-shared state.
//
// The event is best-effort: a missing stream (test broker without an
// allocated buffer for the task) is a silent no-op so unit tests that do
// not subscribe to events keep working without a stream-setup ritual.
func (b *Broker) emitLifecycleManifestLocked(payload lifecycleManifestPayload) {
	if b == nil {
		return
	}
	if payload.EmittedAt.IsZero() {
		payload.EmittedAt = time.Now().UTC()
	}
	body, err := json.Marshal(payload)
	if err != nil {
		// Marshal failure on a closed-shape struct should never happen;
		// fall back to a minimal text payload so the consumer at least
		// sees the subkind.
		body = []byte(`{"subkind":"` + string(payload.Subkind) + `"}`)
	}
	stream := b.lifecycleManifestStreamLocked(payload.TaskID)
	if stream == nil {
		return
	}
	pushHeadlessEvent(stream, HeadlessEvent{
		Type:      HeadlessEventTypeManifest,
		Provider:  "wuphf",
		Bot:       lifecycleManifestStreamSlug,
		TaskID:    strings.TrimSpace(payload.TaskID),
		Status:    "idle",
		Detail:    string(body),
		Text:      string(payload.Subkind),
		StartedAt: payload.EmittedAt.UTC().Format(time.RFC3339),
	})
}

// lifecycleManifestStreamLocked returns the broker-shared per-task stream
// buffer for lifecycle manifests, lazily allocating one on first use.
// Caller holds b.mu.
//
// The synthetic slug is stable (lifecycleManifestStreamSlug) so the
// frontend can subscribe by slug. SSE fan-out treats it like any other
// bot slug; the activity sidebar filters it out by checking for the
// "system." prefix.
func (b *Broker) lifecycleManifestStreamLocked(taskID string) *botStreamBuffer {
	if b == nil {
		return nil
	}
	if b.botStreams == nil {
		b.botStreams = make(map[string]*botStreamBuffer)
	}
	stream, ok := b.botStreams[lifecycleManifestStreamSlug]
	if !ok {
		stream = &botStreamBuffer{}
		b.botStreams[lifecycleManifestStreamSlug] = stream
	}
	return stream
}
