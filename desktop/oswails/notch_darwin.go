//go:build desktop && darwin && cgo

package main

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa -framework WebKit -framework Carbon -framework Speech -framework AVFoundation
#include <stdlib.h>

void GawkNotchStart(const char *officeURL);
*/
import "C"

import (
	"sync"
	"unsafe"
)

// The camera-notch surface (notch_darwin.m). It is a second native window the
// Wails v2 single-window runtime cannot provide, so it is plain Cocoa: a
// transparent NSPanel over the notch hosting a WKWebView of <office>/notch.html.
// It talks to the office over the same loopback HTTP as everything else; the
// only thing crossing into Go is "open the main window at this app path".

var (
	notchOpenMu sync.Mutex
	notchOpenFn func(path string)
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
