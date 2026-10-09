import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { OfficeMember } from "../../api/client";
import { directChannelSlug } from "../../lib/channels";
import { dmBotForChannel, EmptyHero } from "./EmptyHero";

const MEMBERS: OfficeMember[] = [
  { slug: "cos", name: "Chief of Staff", role: "Lead agent" },
  { slug: "zed", name: "Zed", role: "Ops" },
];

describe("dmBotForChannel", () => {
  it("finds the bot on either side of the pair-sort", () => {
    // "cos" sorts before "human", "zed" after it: both orders must resolve.
    expect(dmBotForChannel(directChannelSlug("cos"), MEMBERS)?.slug).toBe(
      "cos",
    );
    expect(dmBotForChannel(directChannelSlug("zed"), MEMBERS)?.slug).toBe(
      "zed",
    );
  });

  it("returns nothing for a channel that is not a roster bot's DM", () => {
    expect(dmBotForChannel("general", MEMBERS)).toBeUndefined();
    expect(
      dmBotForChannel(directChannelSlug("ghost"), MEMBERS),
    ).toBeUndefined();
    expect(dmBotForChannel("", MEMBERS)).toBeUndefined();
  });
});

describe("<EmptyHero>", () => {
  function renderHero(line?: string) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(["office-members"], { members: MEMBERS });
    return render(
      <QueryClientProvider client={client}>
        <EmptyHero slug="cos" line={line} />
      </QueryClientProvider>,
    );
  }

  it("stands the bot there as a character at hero size, with its one line", () => {
    const { container } = renderHero("Say hi to Chief of Staff.");
    expect(screen.getByTestId("empty-hero")).toBeInTheDocument();
    expect(screen.getByText("Say hi to Chief of Staff.")).toBeInTheDocument();
    const char = container.querySelector<HTMLElement>(".toon");
    expect(char?.style.width).toBe("72px");
    // Gloves and a body: a character, not a flat mark.
    expect(container.querySelectorAll(".toon-glove")).toHaveLength(2);
    expect(container.querySelector(".toon-body")).not.toBeNull();
  });

  it("omits the line when none is given", () => {
    const { container } = renderHero();
    expect(container.querySelector(".empty-hero-line")).toBeNull();
  });
});
