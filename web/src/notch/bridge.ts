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
//   { type: "voice", action: "start"|"stop" }  push-to-talk (SFSpeechRecognizer)
//   { type: "stage", height }                  room the collapsed notch needs
//   { type: "ears", width, band }              the ears beside a notch, the band of dots under it
//                                              below the strip (peeks, chat)
//   { type: "sound", on }                      the sound toggle, so native
//                                              can mirror it if it ever plays
//
// Native → page, via evaluateJavaScript:
//   window.gawkNotch.setExpanded(boolean)
//   window.gawkNotch.focusKeyboard()           the global hotkey opened it
//   window.gawkNotch.voice({kind, text, message})  kind: partial|final|error|end
//
// Geometry arrives as query params: ?nw=<notch width>&nh=<notch height>&ew=<ear width>.
// Outside the Mac app (a browser, Storybook, tests) every call is a no-op.

export type NativeMessage =
  | { type: "ready" }
  | { type: "attention"; count: number; headline: string }
  | { type: "open"; path: string }
  | { type: "keyboard"; active: boolean }
  | { type: "collapse" }
  | { type: "voice"; action: "start" | "stop" }
  | { type: "sound"; on: boolean }
  | { type: "stage"; height: number }
  | { type: "ears"; width: number; band: number };

interface WebkitHandlers {
  webkit?: {
    messageHandlers?: {
      gawkNotch?: { postMessage: (msg: NativeMessage) => void };
    };
  };
  gawkNotch?: NativeReceiver;
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

export interface NativeReceiver {
  setExpanded: (expanded: boolean) => void;
  focusKeyboard?: () => void;
  voice?: (event: { kind: string; text?: string; message?: string }) => void;
}

/** Installs window.gawkNotch for the native side; returns an uninstaller. */
export function installNativeReceiver(
  setExpanded: (expanded: boolean) => void,
  extra: Omit<NativeReceiver, "setExpanded"> = {},
): () => void {
  host().gawkNotch = { setExpanded: (v) => setExpanded(!!v), ...extra };
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
    band: 0,
    nativeGlass: params.get("glass") === "1",
  };
}
