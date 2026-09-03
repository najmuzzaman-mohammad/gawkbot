package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/nex-crm/wuphf/internal/bot"
)

// runLogCmd prints task receipts from the local bot log directory.
// No server required — reads directly from ~/.wuphf/office/tasks/.
//
// Usage:
//
//	gawkbot log              — list the 20 most recent tasks
//	gawkbot log <taskID>     — dump the full JSONL for a single task as pretty lines
//	gawkbot log --bot eng  — list recent tasks for a specific bot
//	gawkbot log --limit 50   — override the default list size
func runLogCmd(args []string) {
	fs := flag.NewFlagSet("log", flag.ExitOnError)
	botFilter := fs.String("agent", "", "Filter the list by bot slug (e.g. eng, ceo)")
	limit := fs.Int("limit", 20, "Maximum number of tasks to list")
	jsonOut := fs.Bool("json", false, "Emit raw JSON instead of the pretty table")
	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, "gawkbot log — show bot task receipts")
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "Usage:")
		fmt.Fprintln(os.Stderr, "  gawkbot log                 List recent tasks across all bots")
		fmt.Fprintln(os.Stderr, "  gawkbot log <taskID>        Dump one task's full tool-call history")
		fmt.Fprintln(os.Stderr, "  gawkbot log --bot eng     Filter the list to one bot")
		fmt.Fprintln(os.Stderr, "  gawkbot log --limit 50      Override default list size")
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "Reads from ~/.wuphf/office/tasks/{taskID}/output.log.")
	}
	_ = fs.Parse(args)

	root := bot.DefaultTaskLogRoot()
	positional := fs.Args()
	if len(positional) > 0 {
		taskID := positional[0]
		entries, err := bot.ReadTaskLog(root, taskID)
		if err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
		if *jsonOut {
			enc := json.NewEncoder(os.Stdout)
			enc.SetIndent("", "  ")
			_ = enc.Encode(entries)
			return
		}
		printTaskEntries(taskID, entries)
		return
	}

	tasks, err := bot.ListRecentTasks(root, *limit)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
	if slug := strings.TrimSpace(*botFilter); slug != "" {
		filtered := tasks[:0]
		for _, t := range tasks {
			if t.BotSlug == slug {
				filtered = append(filtered, t)
			}
		}
		tasks = filtered
	}
	if *jsonOut {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		_ = enc.Encode(tasks)
		return
	}
	printTaskList(tasks, root)
}

func printTaskList(tasks []bot.TaskLogSummary, root string) {
	if len(tasks) == 0 {
		fmt.Println("No task receipts yet. (Logs land in " + root + " after bots run.)")
		return
	}
	fmt.Printf("%-20s  %-8s  %-6s  %-16s  %s\n", "TASK", "BOT", "TOOLS", "LAST", "FLAGS")
	for _, t := range tasks {
		last := "-"
		if t.LastToolAt > 0 {
			last = time.UnixMilli(t.LastToolAt).Format("2006-01-02 15:04")
		}
		flag := ""
		if t.HasError {
			flag = "error"
		}
		fmt.Printf("%-20s  %-8s  %6d  %-16s  %s\n", t.TaskID, t.BotSlug, t.ToolCallCount, last, flag)
	}
	fmt.Println("")
	fmt.Println("Dig into one with: gawkbot log <taskID>")
}

func printTaskEntries(taskID string, entries []bot.TaskLogEntry) {
	fmt.Printf("== %s (%d tool calls) ==\n\n", taskID, len(entries))
	for i, e := range entries {
		when := "-"
		if e.StartedAt > 0 {
			when = time.UnixMilli(e.StartedAt).Format("15:04:05")
		}
		outcome := "ok"
		if e.Error != "" {
			outcome = "err: " + shortenErr(e.Error)
		}
		fmt.Printf("#%d  %s  %-20s  %s\n", i+1, when, e.ToolName, outcome)
		if len(e.Params) > 0 {
			raw, _ := json.Marshal(e.Params)
			fmt.Printf("      params: %s\n", truncate(string(raw), 200))
		}
	}
}

func shortenErr(s string) string {
	return truncate(strings.ReplaceAll(s, "\n", " "), 120)
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "..."
}
