import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const readBotFileMock = vi.hoisted(() => vi.fn());
const writeBotFileMock = vi.hoisted(() => vi.fn());
const generateBotFileMock = vi.hoisted(() => vi.fn());

vi.mock("../../api/botFiles", async () => {
  const actual =
    await vi.importActual<typeof import("../../api/botFiles")>(
      "../../api/botFiles",
    );
  return {
    ...actual,
    readBotFile: readBotFileMock,
    writeBotFile: writeBotFileMock,
    generateBotFile: generateBotFileMock,
  };
});

import type { OfficeMember } from "../../api/client";
import { BotInstructionsSection } from "./BotInstructionsSection";

function makeQC() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function wrap(ui: ReactNode) {
  return <QueryClientProvider client={makeQC()}>{ui}</QueryClientProvider>;
}

const specialist: OfficeMember = {
  slug: "growth",
  name: "Growth Lead",
  role: "growth lead",
  built_in: false,
};

const lead: OfficeMember = {
  slug: "ceo",
  name: "CEO",
  role: "lead",
  built_in: true,
};

describe("<AgentInstructionsSection>", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readBotFileMock.mockResolvedValue({
      path: "agents/growth/SOUL.md",
      content: "# SOUL — @growth\nbe relentless",
      sha: "abc123",
      exists: true,
    });
  });

  it("lists the four instruction files and does not fetch until expanded", () => {
    render(wrap(<BotInstructionsSection agent={specialist} />));
    for (const name of ["SOUL", "IDENTITY", "OPERATIONS", "TOOLS"]) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    // Collapsed cards must not fetch.
    expect(readBotFileMock).not.toHaveBeenCalled();
  });

  it("does not show the team USER file for a non-lead bot", () => {
    render(wrap(<BotInstructionsSection agent={specialist} />));
    expect(screen.queryByText("USER")).not.toBeInTheDocument();
    expect(screen.queryByText(/office context/i)).not.toBeInTheDocument();
  });

  it("shows the team USER file for the lead bot", () => {
    render(wrap(<BotInstructionsSection agent={lead} />));
    expect(screen.getByText("USER")).toBeInTheDocument();
    expect(screen.getByText(/office context/i)).toBeInTheDocument();
  });

  it("fetches and renders a file's content when its card is expanded", async () => {
    const user = userEvent.setup();
    render(wrap(<BotInstructionsSection agent={specialist} />));

    await user.click(screen.getByText("SOUL"));

    await waitFor(() => {
      expect(readBotFileMock).toHaveBeenCalledWith("agents/growth/SOUL.md");
    });
    expect(await screen.findByText(/be relentless/)).toBeInTheDocument();
    // Edit affordance is present in view mode.
    expect(screen.getByText("Edit")).toBeInTheDocument();
  });

  it("opens the structured block editor on Edit (default)", async () => {
    const user = userEvent.setup();
    render(wrap(<BotInstructionsSection agent={specialist} />));

    await user.click(screen.getByText("SOUL"));
    await screen.findByText("Edit");
    await user.click(screen.getByText("Edit"));

    // Default editor is structured blocks: the SOUL schema sections each get a
    // labelled textarea, and the file's preamble lands in an Overview block.
    expect(
      await screen.findByRole("textbox", { name: /SOUL — Who you are/i }),
    ).toBeInTheDocument();
    const overview = screen.getByRole("textbox", { name: "Overview" });
    expect((overview as HTMLTextAreaElement).value).toMatch(/be relentless/i);
    // The Blocks/Raw toggle is present, Blocks active.
    expect(screen.getByRole("button", { name: "Blocks" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("edits a section block and saves the reserialized file", async () => {
    readBotFileMock.mockResolvedValue({
      path: "agents/growth/SOUL.md",
      content: "# SOUL — @growth\n\n## Who you are\nold identity\n",
      sha: "abc123",
      exists: true,
    });
    writeBotFileMock.mockResolvedValue({
      path: "agents/growth/SOUL.md",
      commit_sha: "newsha",
      bytes_written: 42,
    });
    const user = userEvent.setup();
    render(wrap(<BotInstructionsSection agent={specialist} />));

    await user.click(screen.getByText("SOUL"));
    await screen.findByText("Edit");
    await user.click(screen.getByText("Edit"));

    const block = await screen.findByRole("textbox", {
      name: /SOUL — Who you are/i,
    });
    expect((block as HTMLTextAreaElement).value).toBe("old identity");
    fireEvent.change(block, { target: { value: "relentless about pipeline" } });
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(writeBotFileMock).toHaveBeenCalled());
    const written = writeBotFileMock.mock.calls[0][0] as { content: string };
    // The save reserializes the blocks back into the file's `## ` structure.
    expect(written.content).toContain("## Who you are");
    expect(written.content).toContain("relentless about pipeline");
    // Saving returns to the view (Edit button visible again).
    await waitFor(() => expect(screen.getByText("Edit")).toBeInTheDocument());
  });

  it("can switch to the Raw (advanced) editor", async () => {
    const user = userEvent.setup();
    render(wrap(<BotInstructionsSection agent={specialist} />));

    await user.click(screen.getByText("SOUL"));
    await screen.findByText("Edit");
    await user.click(screen.getByText("Edit"));
    await screen.findByRole("textbox", { name: "Overview" });

    // Raw is the escape hatch: the whole file as one markdown textarea.
    await user.click(screen.getByRole("button", { name: "Raw" }));
    const raw = await screen.findByLabelText(/raw markdown editor for SOUL/i);
    expect((raw as HTMLTextAreaElement).value).toMatch(/be relentless/i);
  });

  it("does not wipe unsaved raw edits when the active Raw tab is re-clicked", async () => {
    const user = userEvent.setup();
    render(wrap(<BotInstructionsSection agent={specialist} />));

    await user.click(screen.getByText("SOUL"));
    await screen.findByText("Edit");
    await user.click(screen.getByText("Edit"));
    await screen.findByRole("textbox", { name: "Overview" });

    await user.click(screen.getByRole("button", { name: "Raw" }));
    const raw = await screen.findByLabelText(/raw markdown editor for SOUL/i);
    fireEvent.change(raw, {
      target: { value: "# SOUL — @growth\nedited raw" },
    });

    // Re-clicking the already-active Raw tab must preserve the edit, not
    // re-seed the textarea from disk content.
    await user.click(screen.getByRole("button", { name: "Raw" }));
    expect((raw as HTMLTextAreaElement).value).toBe(
      "# SOUL — @growth\nedited raw",
    );
  });

  it("surfaces the seeded badge when a file has not been written yet", async () => {
    readBotFileMock.mockResolvedValue({
      path: "agents/growth/SOUL.md",
      content: "# SOUL — @growth\nseed",
      sha: "",
      exists: false,
    });
    const user = userEvent.setup();
    render(wrap(<BotInstructionsSection agent={specialist} />));

    await user.click(screen.getByText("SOUL"));
    expect(await screen.findByText(/seeded/)).toBeInTheDocument();
  });

  it("offers Generate with AI on prose files but not factual ones", async () => {
    const user = userEvent.setup();
    render(wrap(<BotInstructionsSection agent={specialist} />));

    // SOUL (prose) → Generate offered.
    await user.click(screen.getByText("SOUL"));
    await screen.findByText("Edit");
    expect(screen.getByText("Generate with AI")).toBeInTheDocument();

    // IDENTITY (factual) → no Generate affordance.
    readBotFileMock.mockResolvedValue({
      path: "agents/growth/IDENTITY.md",
      content: "# IDENTITY — @growth",
      sha: "i1",
      exists: true,
    });
    await user.click(screen.getByText("IDENTITY"));
    await waitFor(() => {
      expect(screen.getAllByText("Edit").length).toBeGreaterThan(0);
    });
    // Only the SOUL card's Generate button exists; IDENTITY adds none.
    expect(screen.getAllByText("Generate with AI")).toHaveLength(1);
  });

  it("generates a draft and opens the editor seeded with it", async () => {
    generateBotFileMock.mockResolvedValue({
      path: "agents/growth/SOUL.md",
      content: "# SOUL — @growth\nAI-authored, vivid and specific",
    });
    const user = userEvent.setup();
    render(wrap(<BotInstructionsSection agent={specialist} />));

    await user.click(screen.getByText("SOUL"));
    await user.click(await screen.findByText("Generate with AI"));

    await waitFor(() => {
      expect(generateBotFileMock).toHaveBeenCalledWith("agents/growth/SOUL.md");
    });
    // The block editor opens seeded with the generated draft — the prose with
    // no `## ` sections lands in the Overview block.
    const overview = await screen.findByRole("textbox", { name: "Overview" });
    expect((overview as HTMLTextAreaElement).value).toMatch(
      /AI-authored, vivid and specific/,
    );
  });

  it("surfaces a generation error without opening the editor", async () => {
    generateBotFileMock.mockRejectedValue(new Error("model unavailable"));
    const user = userEvent.setup();
    render(wrap(<BotInstructionsSection agent={specialist} />));

    await user.click(screen.getByText("SOUL"));
    await user.click(await screen.findByText("Generate with AI"));

    expect(await screen.findByText("model unavailable")).toBeInTheDocument();
    // No editor opened — still in the view (the Edit affordance is showing).
    expect(screen.getByText("Edit")).toBeInTheDocument();
  });
});
