// Package calendar implements bot heartbeat scheduling with cron-style expressions.
package calendar

import "time"

// ScheduleEntry represents a recurring schedule for a bot.
type ScheduleEntry struct {
	BotSlug     string    `json:"agent_slug"`
	CronExpr    string    `json:"cron_expr"`
	Description string    `json:"description,omitempty"`
	Enabled     bool      `json:"enabled"`
	NextFire    time.Time `json:"next_fire"`
}

// EventStatus indicates whether a calendar event fired or was missed.
type EventStatus string

const (
	StatusPending EventStatus = "pending"
	StatusFired   EventStatus = "fired"
	StatusMissed  EventStatus = "missed"
)

// CalendarEvent represents a single scheduled occurrence.
type CalendarEvent struct {
	BotSlug     string      `json:"agent_slug"`
	ScheduledAt time.Time   `json:"scheduled_at"`
	FiredAt     time.Time   `json:"fired_at,omitempty"`
	Status      EventStatus `json:"status"`
}
