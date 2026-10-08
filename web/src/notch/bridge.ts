import type { NotchGeometry } from "./types";

// The notch page runs inside a WKWebView owned by the Mac app
// (desktop/oswails/notch_darwin.m). This is the whole contract between them.
//
// Page → native, via window.webkit.messageHandlers.gawkNotch.postMessage:
//   { type: "ready" }                          page mounted
//   { type: "attention", count, headline }     something new needs the human:
//                                              native taps the trackpad and
//                                              peeks the notch open
//   { type: "open", path }                     open the main window at path
//   { type: "keyboard", active }               the message box wants focus
//   { type: "collapse" }                       close the panel
//
// Native → page, via evaluateJavaScript:
//   window.gawkNotch.setExpanded(boolean)
//
// Geometry arrives as query params: ?nw=<notch width>&nh=<notch height>&ew=<ear width>.
// Outside the Mac app (a browser, Storybook, tests) every call is a no-op.

export type NativeMessage =
  | { type: "ready" }
  | { type: "attention"; count: number; headline: string }
  | { type: "open"; path: string }
  | { type: "keyboard"; active: boolean }
  | { type: "collapse" };

interface WebkitHandlers {
  webkit?: {
    messageHandlers?: {
      gawkNotch?: { postMessage: (msg: NativeMessage) => void };
    };
  };
  gawkNotch?: { setExpanded: (expanded: boolean) => void };
}

function host(): WebkitHandlers {
  return window as unknown as WebkitHandlers;
}

export function isInMacApp(): boolean {
  return !!host().webkit?.messageHandlers?.gawkNotch;
}

export function postNative(msg: NativeMessage): void {
  try {
    host().webkit?.messageHandlers?.gawkNotch?.postMessage(msg);
  } catch {
    // The native side went away (app quitting); nothing to tell.
  }
}

/** Installs window.gawkNotch for the native side; returns an uninstaller. */
export function installNativeReceiver(
  setExpanded: (expanded: boolean) => void,
): () => void {
  host().gawkNotch = { setExpanded: (v) => setExpanded(!!v) };
  return () => {
    delete host().gawkNotch;
  };
}

function num(params: URLSearchParams, key: string, fallback: number): number {
  const v = Number(params.get(key));
  return Number.isFinite(v) && v >= 0 && params.has(key) ? v : fallback;
}

export function readGeometry(search: string): NotchGeometry {
  const params = new URLSearchParams(search);
  return {
    notchWidth: num(params, "nw", 0),
    notchHeight: num(params, "nh", 32),
    earWidth: num(params, "ew", 64),
  };
}
