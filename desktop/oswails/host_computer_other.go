//go:build !desktop || !darwin || !cgo

package main

import (
	"io"

	"github.com/nex-crm/wuphf/internal/team"
)

// The person's Mac as a computer exists only in the macOS app.
type macHost struct{}

func startHostComputer(*team.Broker, io.Writer) *macHost { return nil }

func attachHostComputer(string, io.Writer) *macHost { return nil }

func (h *macHost) Stop() {}
