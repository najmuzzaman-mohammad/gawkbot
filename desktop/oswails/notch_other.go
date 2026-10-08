//go:build desktop && !(darwin && cgo)

package main

// startNotch is a no-op off macOS (and on a cgo-less darwin build, which
// cannot link Cocoa): the camera-notch surface is a Mac-only
// affordance (Windows and Linux have no notch to hang it from).
func startNotch(string, func(string)) {}
