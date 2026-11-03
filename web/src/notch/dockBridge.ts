// The dock page (notch.html?dock=1) runs inside a second WKWebView owned by
// the Mac app (desktop/oswails/dock_darwin.m). Its whole contract:
//
// Page → native, via window.webkit.messageHandlers.gawkDock.postMessage:
//   { type: "dock", height, count }   the room the cards need; 0 hides them
//   { type: "open", path }            open the main window at path
//   { type: "chat", slug }            open the notch on that bot's chat
//
// Outside the Mac app (a browser, Storybook, tests) every call is a no-op.

export type DockMessage =
  | { type: "dock"; height: number; count: number }
  | { type: "open"; path: string }
  | { type: "chat"; slug: string };

interface DockHost {
  webkit?: {
    messageHandlers?: {
      gawkDock?: { postMessage: (msg: DockMessage) => void };
    };
  };
}

export function postDock(msg: DockMessage): void {
  try {
    (
      window as unknown as DockHost
    ).webkit?.messageHandlers?.gawkDock?.postMessage(msg);
  } catch {
    // The native side went away (app quitting); nothing to tell.
  }
}

/** Whether this page was opened as the dock by the Mac app. */
export function isDockPage(search = window.location.search): boolean {
  return new URLSearchParams(search).get("dock") === "1";
}
