import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useAppStore } from "../../stores/app";
import { ChannelHeader } from "./ChannelHeader";

vi.mock("../../hooks/useChannels", () => ({
  useChannels: () => ({ data: [] }),
}));

// The breadcrumb resolves an app's real name instead of title-casing its id,
// so the header now reads the apps list. That makes a QueryClient a genuine
// dependency of rendering it, not a test detail.
vi.mock("../../api/apps", () => ({
  listApps: vi.fn(async () => []),
}));

function renderHeader(ui: ReactElement = <ChannelHeader />) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

vi.mock("../../routes/useCurrentRoute", () => ({
  useCurrentRoute: () => ({ kind: "channel", channelSlug: "general" }),
}));

afterEach(() => {
  useAppStore.setState({ theme: "nex" });
  document.documentElement.setAttribute("data-theme", "nex");
});

describe("<ChannelHeader>", () => {
  it("opens the theme switcher and switches to Dark", () => {
    useAppStore.setState({ theme: "nex" });

    renderHeader();

    const trigger = screen.getByRole("button", {
      name: /Theme: Light\. Open theme switcher\./,
    });
    fireEvent.click(trigger);

    // Anchored: "Glass Dark" also contains "Dark".
    const dark = screen.getByRole("menuitemradio", { name: /^Dark/ });
    fireEvent.click(dark);

    expect(useAppStore.getState().theme).toBe("nex-dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe(
      "nex-dark",
    );
  });

  it("marks the active theme as checked", () => {
    useAppStore.setState({ theme: "noir-gold" });

    renderHeader();

    fireEvent.click(
      screen.getByRole("button", {
        name: /Theme: Noir Gold\. Open theme switcher\./,
      }),
    );

    const noir = screen.getByRole("menuitemradio", { name: /Noir Gold/ });
    expect(noir).toHaveAttribute("aria-checked", "true");
  });

  it("closes the menu on Escape", () => {
    useAppStore.setState({ theme: "nex" });

    renderHeader();

    fireEvent.click(
      screen.getByRole("button", {
        name: /Theme: Light\. Open theme switcher\./,
      }),
    );
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes the menu on outside pointerdown", () => {
    useAppStore.setState({ theme: "nex" });

    renderHeader();

    fireEvent.click(
      screen.getByRole("button", {
        name: /Theme: Light\. Open theme switcher\./,
      }),
    );
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("navigates menu items with arrow keys", () => {
    useAppStore.setState({ theme: "nex" });

    renderHeader();

    fireEvent.click(
      screen.getByRole("button", {
        name: /Theme: Light\. Open theme switcher\./,
      }),
    );

    const menu = screen.getByRole("menu");
    const items = screen.getAllByRole("menuitemradio");

    // Menu opens with focus on the active item (Light — index 3, after
    // the two Glass flavours and Shell; the default leads the registry).
    expect(document.activeElement).toBe(items[3]);

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[4]);

    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(items[items.length - 1]);

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[0]);

    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[items.length - 1]);

    fireEvent.keyDown(menu, { key: "Home" });
    expect(document.activeElement).toBe(items[0]);
  });
});
