import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { QUIET_OFFICE } from "./fixtures";
import { NotchApp } from "./NotchApp";
import { resetNudges } from "./nudge";

// The Mac app tells the page the open panel's size (dragged, remembered),
// and the page lays out to exactly that instead of the size it loaded with.

vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  getNotchState: () => Promise.resolve(QUIET_OFFICE),
}));

type Receiver = {
  setExpanded: (v: boolean) => void;
  setSize?: (w: number, h: number) => void;
  setMode?: (mode: string) => void;
};
type NotchHost = { webkit?: unknown; gawkNotch?: Receiver };

beforeEach(() => {
  resetNudges();
  (window as unknown as NotchHost).webkit = {
    messageHandlers: { gawkNotch: { postMessage: () => undefined } },
  };
});
afterEach(() => {
  cleanup();
  (window as unknown as NotchHost).webkit = undefined;
});

describe("the open panel's size", () => {
  it("is what the app says it is, once it says", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <NotchApp search="?nw=180&nh=32&xw=640&xh=820" />
      </QueryClientProvider>,
    );
    const native = (window as unknown as NotchHost).gawkNotch;
    expect(native?.setSize).toBeTypeOf("function");
    // Hovering opens the short list, as wide as its rows and as tall.
    await act(async () => {
      native?.setMode?.("peek");
      native?.setExpanded(true);
    });
    expect(screen.getByTestId("notch-shell").style.width).toBe("340px");
    expect(screen.getByTestId("notch-shell").style.height).toBe("auto");
    // The hotkey opens Home at the size the app keeps.
    await act(async () => {
      native?.setMode?.("home");
    });
    expect(screen.getByTestId("notch-shell").style.width).toBe("640px");
    await act(async () => {
      native?.setSize?.(900, 700);
    });
    expect(screen.getByTestId("notch-shell").style.width).toBe("900px");
    expect(screen.getByTestId("notch-shell").style.height).toBe("700px");
    // Nonsense is ignored.
    await act(async () => {
      native?.setSize?.(0, -1);
    });
    expect(screen.getByTestId("notch-shell").style.width).toBe("900px");
  });
});
