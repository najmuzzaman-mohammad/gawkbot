package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/nex-crm/wuphf/internal/computer"
	"github.com/nex-crm/wuphf/internal/computer/box"
)

// runComputerMCP is the `gawkbot computer-mcp <runtime> <container> <socket>`
// entry point: a transparent stdio bridge into Cua Driver's MCP server
// inside the bot's container, with the who-is-driving gate on the near
// side. See internal/computer/bridge.go.
func runComputerMCP(args []string) int {
	if len(args) == 2 && args[0] == "box" {
		return runBoxMCP(args[1])
	}
	if len(args) == 3 && args[0] == "--host" {
		return runHostMCP(args[1], args[2])
	}
	if len(args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: gawkbot computer-mcp <runtime> <container> <socket> | gawkbot computer-mcp box <box-id>")
		return 2
	}
	rt, container, socket := args[0], args[1], args[2]
	if err := computer.ValidBridgeArgs(rt, container, socket); err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		return 2
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()
	// The control pair rides in env, never argv: argv is world-readable
	// through ps for the life of the bridge.
	gate := &computer.GateClient{
		URL:   os.Getenv("WUPHF_COMPUTER_CONTROL_URL"),
		Token: os.Getenv("WUPHF_COMPUTER_CONTROL_TOKEN"),
	}
	err := computer.RunBridge(ctx, computer.BridgeConfig{
		Command: rt,
		Args:    computer.CuaExecArgs([]string{"mcp", "--socket", socket}, container, true),
		Gate:    gate,
		Stdin:   os.Stdin,
		Stdout:  os.Stdout,
		Stderr:  os.Stderr,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "computer bridge ended: %v\n", err)
		return 1
	}
	return 0
}

// runHostMCP bridges a bot into the driver the Mac app spawned (the
// person's own Mac), under the host policy (internal/computer/host.go).
func runHostMCP(socket, slug string) int {
	if err := computer.ValidHostBridgeArgs(socket, slug); err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		return 2
	}
	driver := strings.TrimSpace(os.Getenv("GAWKBOT_CUA_DRIVER"))
	if driver == "" {
		fmt.Fprintln(os.Stderr, "GAWKBOT_CUA_DRIVER is required for the host bridge")
		return 2
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()
	gate := &computer.GateClient{
		URL:   os.Getenv("WUPHF_COMPUTER_CONTROL_URL"),
		Token: os.Getenv("WUPHF_COMPUTER_CONTROL_TOKEN"),
	}
	err := computer.RunBridge(ctx, computer.BridgeConfig{
		Command: driver,
		Args:    []string{"mcp", "--embedded", "--socket", socket},
		Gate:    gate,
		Host: &computer.HostPolicy{
			Slug:        slug,
			Label:       strings.TrimSpace(os.Getenv("GAWKBOT_BOT_LABEL")),
			Color:       strings.TrimSpace(os.Getenv("GAWKBOT_BOT_COLOR")),
			AlwaysAllow: os.Getenv("GAWKBOT_MAC_ALWAYS_ALLOW") == "1",
		},
		Stdin:  os.Stdin,
		Stdout: os.Stdout,
		Stderr: os.Stderr,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "computer bridge ended: %v\n", err)
		return 1
	}
	return 0
}

// runBoxMCP serves the cloud computer tools for an ascii.dev box.
func runBoxMCP(boxID string) int {
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()
	client := box.NewClient(os.Getenv("WUPHF_BOX_API_KEY"))
	if api := os.Getenv("WUPHF_BOX_API"); api != "" {
		client.API = api
	}
	gate := &computer.GateClient{
		URL:   os.Getenv("WUPHF_COMPUTER_CONTROL_URL"),
		Token: os.Getenv("WUPHF_COMPUTER_CONTROL_TOKEN"),
	}
	if err := box.RunProxy(ctx, client, boxID, gate); err != nil {
		fmt.Fprintf(os.Stderr, "cloud computer proxy ended: %v\n", err)
		return 1
	}
	return 0
}
