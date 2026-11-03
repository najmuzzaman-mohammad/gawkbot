import type { NotchGeometry, NotchHotkey, OverlayScene } from "./types";

/** The open panel's size outside the Mac app, which sends its own. */
export const EXPANDED_WIDTH = 760;
export const EXPANDED_HEIGHT = 500;

// The notch page runs inside a WKWebView owned by the Mac app
// (desktop/oswails/notch_darwin.m). This is the whole contract between them.
//
// Page → native, via window.webkit.messageHandlers.gawkNotch.postMessage:
//   { type: "ready" }                          page mounted
//   { type: "open", path }                     open the main window at path
//   { type: "keyboard", active }               the message box wants focus
//   { type: "collapse" }                       close the panel
//   { type: "voice", action: "start"|"stop" }  push-to-talk (SFSpeechRecognizer)
//   { type: "ears", width, band }              the ears beside a notch, the band of dots under it
//   { type: "sound", on }                      the sound toggle, so native
//                                              can mirror it if it ever plays
//   { type: "browse", url }                    open an https page in the browser
//   { type: "say", text } / { type: "hush" }   speak a line (AVSpeechSynthesizer), stop it
//   { type: "home" }                           grow from the hover list to Home, and stay open
//   { type: "peek", height }                   the hover list's height, strip included
//
// Native → page, via evaluateJavaScript:
//   window.gawkNotch.setExpanded(boolean)
//   window.gawkNotch.setSize(width, height)   the open panel's size (resizable, remembered)
//   window.gawkNotch.focusKeyboard()           the global hotkey opened it (Home)
//   window.gawkNotch.setMode("peek"|"home")    hover opened the list, or the hotkey Home
//   window.gawkNotch.showAgent(slug)           a card at the top right asked for that bot
//   window.gawkNotch.voice({kind, text, message})  kind: partial|final|error|end
//
// Geometry arrives as query params: ?nw=<notch width>&nh=<notch height>&ew=<ear width>.
// The working-bot cards at the top right are the same page with ?dock=1 and
// their own, smaller contract (dockBridge.ts).
// Outside the Mac app (a browser, Storybook, tests) every call is a no-op.

export type NativeMessage =
  | { type: "ready" }
  | { type: "open"; path: string }
  | { type: "keyboard"; active: boolean }
  | { type: "collapse" }
  | { type: "voice"; action: "start" | "stop" }
  | { type: "sound"; on: boolean }
  | { type: "ears"; width: number; band: number }
  /** Ask macOS for a grant; the app shows the prompt, the driver never does. */
  | { type: "permission"; kind: "accessibility" | "screen_recording" }
  /** Draw on the screen, or clear it when the scene is null. */
  | { type: "overlay"; scene: OverlayScene | null }
  /** Open an https page in the default browser (a sign-in page). */
  | { type: "browse"; url: string }
  /** Say a line out loud in the Mac's voice; hush stops it mid-word. */
  | { type: "say"; text: string }
  | { type: "hush" }
  /** Grow from the hover list to Home and stay open. */
  | { type: "home" }
  /** The hover list's height, strip included, for the panel to fit. */
  | { type: "peek"; height: number };

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
  /** The open panel's size, as the person last dragged it. */
  setSize?: (width: number, height: number) => void;
  focusKeyboard?: () => void;
  /** How the panel opened: the hover list, or Home. */
  setMode?: (mode: string) => void;
  /** Open Home on one bot's chat (a card at the top right asked). */
  showAgent?: (slug: string) => void;
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
    expandedWidth: num(params, "xw", EXPANDED_WIDTH),
    expandedHeight: num(params, "xh", EXPANDED_HEIGHT),
    hotkey: readHotkey(params.get("hk")),
  };
}

function readHotkey(v: string | null): NotchHotkey | undefined {
  if (v === "alt" || v === "ctrl-alt" || v === "") return v;
  return undefined;
}
