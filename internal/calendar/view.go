package calendar

import (
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
)

// botDay groups a bot's fire times for a single day.
type botDay struct {
	Slug  string
	Times []string
}

// Bot colors for the calendar grid markers.
var botColors = []string{
	"#2980fb", // blue
	"#cf72d9", // purple
	"#97a022", // green
	"#EAB308", // yellow
	"#03a04c", // emerald
	"#df750c", // orange
	"#e23428", // red
	"#60A5FA", // light blue
}

// RenderWeekGrid renders a 7-day calendar grid for the given week start.
// weekStart should be a Monday at 00:00.
func RenderWeekGrid(store *CalendarStore, weekStart time.Time) string {
	days := []string{"Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"}
	colWidth := 10
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#cf72d9"))
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#838485"))
	dividerStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#374151"))

	// Header row
	var headerCells []string
	for _, d := range days {
		headerCells = append(headerCells, headerStyle.Width(colWidth).Render(d))
	}
	header := strings.Join(headerCells, " ")

	// Divider
	var divParts []string
	for range days {
		divParts = append(divParts, dividerStyle.Render(strings.Repeat("─", colWidth)))
	}
	divider := strings.Join(divParts, " ")

	// Collect events per day
	events := store.GetEventsForWeek(weekStart)
	type daySlot struct {
		BotSlug string
		Time    string
	}
	daySlots := make([][]daySlot, 7)
	for _, ev := range events {
		evLocal := ev.ScheduledAt.In(weekStart.Location())
		evMidnight := time.Date(evLocal.Year(), evLocal.Month(), evLocal.Day(), 0, 0, 0, 0, weekStart.Location())
		startMidnight := time.Date(weekStart.Year(), weekStart.Month(), weekStart.Day(), 0, 0, 0, 0, weekStart.Location())
		// Round to nearest day to absorb DST-induced 23/25-hour days.
		dayIdx := int((evMidnight.Sub(startMidnight) + 12*time.Hour) / (24 * time.Hour))
		if dayIdx < 0 || dayIdx >= 7 {
			continue
		}
		daySlots[dayIdx] = append(daySlots[dayIdx], daySlot{
			BotSlug: ev.BotSlug,
			Time:    ev.ScheduledAt.Format("15:04"),
		})
	}

	// Deduplicate per day: group by bot, show count if >1
	dayBots := make([][]botDay, 7)
	for d := 0; d < 7; d++ {
		seen := map[string]*botDay{}
		var order []string
		for _, slot := range daySlots[d] {
			if ad, ok := seen[slot.BotSlug]; ok {
				ad.Times = append(ad.Times, slot.Time)
			} else {
				ad := &botDay{Slug: slot.BotSlug, Times: []string{slot.Time}}
				seen[slot.BotSlug] = ad
				order = append(order, slot.BotSlug)
			}
		}
		for _, slug := range order {
			dayBots[d] = append(dayBots[d], *seen[slug])
		}
	}

	// Build color map for bots
	schedules := store.ListSchedules()
	colorMap := make(map[string]string)
	for i, s := range schedules {
		colorMap[s.BotSlug] = botColors[i%len(botColors)]
	}

	// Determine max rows needed
	maxRows := 0
	for _, bots := range dayBots {
		rows := 0
		for range bots {
			rows += 2 // name + time summary
		}
		if rows > maxRows {
			maxRows = rows
		}
	}
	if maxRows == 0 {
		return header + "\n" + divider + "\n" + mutedStyle.Render("  No scheduled events this week.")
	}

	// Render grid rows
	var gridLines []string
	for row := 0; row < maxRows; row++ {
		var cells []string
		for d := 0; d < 7; d++ {
			cell := renderDayCell(dayBots[d], row, colWidth, colorMap)
			cells = append(cells, cell)
		}
		gridLines = append(gridLines, strings.Join(cells, " "))
	}

	// Week label
	weekEnd := weekStart.Add(6 * 24 * time.Hour)
	weekLabel := mutedStyle.Render(fmt.Sprintf("  Week of %s - %s",
		weekStart.Format("Jan 2"),
		weekEnd.Format("Jan 2, 2006")))

	parts := []string{weekLabel, "", header, divider}
	parts = append(parts, gridLines...)
	return strings.Join(parts, "\n")
}

// renderDayCell renders a single cell for a day column at the given row index.
func renderDayCell(bots []botDay, row, width int, colorMap map[string]string) string {
	// Each bot takes 2 rows: name, time
	currentRow := 0
	for _, ad := range bots {
		if row == currentRow {
			// Bot name row
			color := colorMap[ad.Slug]
			if color == "" {
				color = "#838485"
			}
			style := lipgloss.NewStyle().Foreground(lipgloss.Color(color)).Bold(true)
			name := ad.Slug
			if len(name) > width-1 {
				name = name[:width-1]
			}
			return style.Width(width).Render(name)
		}
		if row == currentRow+1 {
			// Time row
			timeStr := ad.Times[0]
			if len(ad.Times) > 1 {
				timeStr = fmt.Sprintf("%s +%d", ad.Times[0], len(ad.Times)-1)
			}
			mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#838485"))
			return mutedStyle.Width(width).Render(timeStr)
		}
		currentRow += 2
	}
	return strings.Repeat(" ", width)
}

// MondayOfWeek returns the Monday 00:00 of the week containing t.
func MondayOfWeek(t time.Time) time.Time {
	weekday := t.Weekday()
	if weekday == time.Sunday {
		weekday = 7
	}
	offset := int(weekday) - int(time.Monday)
	monday := t.AddDate(0, 0, -offset)
	return time.Date(monday.Year(), monday.Month(), monday.Day(), 0, 0, 0, 0, t.Location())
}
