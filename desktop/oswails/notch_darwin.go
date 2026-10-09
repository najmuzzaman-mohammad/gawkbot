//go:build desktop && darwin && cgo

package main

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa -framework WebKit -framework Carbon -framework Speech -framework AVFoundation -framework QuartzCore
#include <stdlib.h>

void GawkNotchStart(const char *officeURL);
*/
import "C"

import (
	"sync"
	"sync/atomic"
	"unsafe"
)

// The camera-notch surface (notch_darwin.m). It is a second native window the
// Wails v2 single-window runtime cannot provide, so it is plain Cocoa: a
// transparent NSPanel over the notch hosting a WKWebView of <office>/notch.html.
// It talks to the office over the same loopback HTTP as everything else; all
// that crosses into Go is "open the main window at this app path" and
// whether the global hotkey registered.

var (
	notchOpenMu sync.Mutex
	notchOpenFn func(path string)
	// notchHotKeyStatus is the OSStatus of registering the global ⌃⌥Space
	// hotkey (notch_darwin.m registerHotKey): 0 once it took, otherwise the
	// Carbon error, so a diagnostics surface can say the shortcut is gone.
	notchHotKeyStatus atomic.Int32
)

// startNotch shows the notch for officeURL. onOpen runs on its own goroutine
// when the notch asks to open the main window at an app path (validated as
// a same-origin path by the native side and again by safeAppPath).
func startNotch(officeURL string, onOpen func(path string)) {
	notchOpenMu.Lock()
	notchOpenFn = onOpen
	notchOpenMu.Unlock()
	cURL := C.CString(officeURL)
	defer C.free(unsafe.Pointer(cURL))
	C.GawkNotchStart(cURL)
}

//export goNotchHotKeyStatus
func goNotchHotKeyStatus(status C.int) {
	notchHotKeyStatus.Store(int32(status))
}

//export goNotchOpen
func goNotchOpen(cPath *C.char) {
	path, ok := safeAppPath(C.GoString(cPath))
	if !ok {
		return
	}
	notchOpenMu.Lock()
	fn := notchOpenFn
	notchOpenMu.Unlock()
	if fn != nil {
		// Off the Cocoa main thread: the Wails runtime calls fn makes may
		// themselves dispatch onto the main queue, which would deadlock here.
		go fn(path)
	}
}
