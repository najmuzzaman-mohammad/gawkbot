import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { QUIET_OFFICE } from "./fixtures";
import { NotchSettings } from "./NotchSettings";

const saved: object[] = [];
let served: Record<string, unknown> = {};
vi.mock("../api/client", async (original) => ({
  ...(await original<typeof import("../api/client")>()),
  getConfig: () => Promise.resolve(served),
  updateConfig: (patch: object) => {
    saved.push(patch);
    return Promise.resolve({ status: "ok" });
  },
}));

afterEach(cleanup);
beforeEach(() => {
  saved.length = 0;
});

function mount(state = QUIET_OFFICE) {
  const onBack = vi.fn();
  const onOpen = vi.fn();
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <NotchSettings state={state} onBack={onBack} onOpen={onOpen} />
    </QueryClientProvider>,
  );
  return { onBack, onOpen };
}

describe("the notch's own settings", () => {
  it("shows each switch as saved and saves only the one touched", async () => {
    served = {
      notch_jump_out: false,
      notch_announce: true,
      mac_computer_always_allow: false,
      openai_key_set: true,
      realtime_voice: "cedar",
    };
    mount();
    const jump = (await screen.findByTestId(
      "nset-jump-out",
    )) as HTMLInputElement;
    await waitFor(() => expect(jump.checked).toBe(false));
    expect(
      (screen.getByTestId("nset-announce") as HTMLInputElement).checked,
    ).toBe(true);
    expect((screen.getByTestId("nset-voice") as HTMLSelectElement).value).toBe(
      "cedar",
    );
    const user = userEvent.setup();
    await user.click(jump);
    expect(saved).toEqual([{ notch_jump_out: true }]);
    await user.selectOptions(screen.getByTestId("nset-voice"), "marin");
    expect(saved.at(-1)).toEqual({ realtime_voice: "marin" });
  });

  it("keeps the voice picker off without a key, and offers the grants the app lacks", async () => {
    served = { openai_key_set: false };
    const { onBack, onOpen } = mount({
      ...QUIET_OFFICE,
      capabilities: {
        voice_realtime: false,
        screen_context: true,
        screen_capture: false,
        pointer: true,
        mac_computer: true,
      },
      permissions: { accessibility: true, screen_recording: false },
    });
    await screen.findByTestId("nset-jump-out");
    expect(
      (screen.getByTestId("nset-voice") as HTMLSelectElement).disabled,
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: "Allow Screen Recording" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Allow Accessibility" }),
    ).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "All settings ↗" }));
    expect(onOpen).toHaveBeenCalledWith("/apps/settings");
  });

  it("says to open the app when it is a plain page", async () => {
    served = {};
    mount(QUIET_OFFICE);
    await screen.findByTestId("nset-jump-out");
    expect(screen.getByText(/Open gawkbot as an app/)).toBeInTheDocument();
  });
});
