import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DataSpace } from "../../../api/dataspaces";
import { createTestClient, renderData } from "../../data/index/dataTestKit";
import { DataTab, groupSpacesForBot } from "./DataTab";

const holder = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("../../../api/dataspacesClient", () => ({
  get dataClient() {
    return holder.client;
  },
}));

beforeEach(() => {
  holder.client = null;
});

function space(
  id: string,
  owner: string,
  access: DataSpace["access"],
): DataSpace {
  return {
    id,
    name: id,
    description: "",
    owner,
    access,
    objectTypeCount: 1,
    recordCount: 1,
    attachedAppIds: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    callerLevel: "write",
  };
}

describe("groupSpacesForBot", () => {
  const owned = space("owned", "ops", { scope: "private", grants: [] });
  const ownedGlobal = space("owned-global", "ops", {
    scope: "global",
    grants: [],
  });
  const sharedIn = space("shared-in", "cos", {
    scope: "shared",
    grants: [{ bot: "ops", level: "read" }],
  });
  const sharedElsewhere = space("shared-elsewhere", "cos", {
    scope: "shared",
    grants: [{ bot: "recruiter", level: "write" }],
  });
  const globalSpace = space("global", "cos", { scope: "global", grants: [] });
  const privateElsewhere = space("private-elsewhere", "cos", {
    scope: "private",
    grants: [],
  });
  const all = [
    owned,
    ownedGlobal,
    sharedIn,
    sharedElsewhere,
    globalSpace,
    privateElsewhere,
  ];

  it("splits by how the bot got access, owned first", () => {
    const groups = groupSpacesForBot(all, "ops");
    expect(groups.map((group) => group.key)).toEqual([
      "owned",
      "shared",
      "global",
    ]);
    expect(groups[0]?.spaces.map((s) => s.id)).toEqual([
      "owned",
      "owned-global",
    ]);
    expect(groups[1]?.spaces.map((s) => s.id)).toEqual(["shared-in"]);
    expect(groups[2]?.spaces.map((s) => s.id)).toEqual(["global"]);
  });

  it("never lists a space twice and never lists one the bot cannot reach", () => {
    const ids = groupSpacesForBot(all, "ops").flatMap((group) =>
      group.spaces.map((s) => s.id),
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain("private-elsewhere");
    expect(ids).not.toContain("shared-elsewhere");
  });

  it("drops empty groups", () => {
    expect(groupSpacesForBot([owned], "ops").map((g) => g.key)).toEqual([
      "owned",
    ]);
  });
});

describe("<DataTab>", () => {
  it("shows what @ops owns, what it was let into, and what is global", async () => {
    holder.client = createTestClient();
    renderData(<DataTab agentSlug="ops" />, "/agents/ops/data");

    const owns = await screen.findByRole("heading", { name: "Owns" });
    const ownsSection = owns.closest("section");
    expect(ownsSection).not.toBeNull();
    if (!ownsSection) throw new Error("owns section missing");
    expect(
      within(ownsSection).getByRole("link", { name: "Client delivery" }),
    ).toHaveAttribute("href", "/data/space_client_delivery");

    const shared = screen.getByRole("heading", { name: "Shared with it" });
    const sharedSection = shared.closest("section");
    if (!sharedSection) throw new Error("shared section missing");
    // @ops holds a read grant on Recruiting, which @recruiter owns.
    expect(
      within(sharedSection).getByRole("link", { name: "Recruiting" }),
    ).toBeInTheDocument();
    expect(within(sharedSection).getByText("Can read")).toBeInTheDocument();
    expect(within(sharedSection).getByText("@recruiter")).toBeInTheDocument();

    const globalHeading = screen.getByRole("heading", { name: "Global" });
    const globalSection = globalHeading.closest("section");
    if (!globalSection) throw new Error("global section missing");
    expect(
      within(globalSection).getByRole("link", { name: "Company directory" }),
    ).toBeInTheDocument();

    // Seed raise is private to @cos, so @ops never sees it.
    expect(screen.queryByText("Seed raise")).not.toBeInTheDocument();
  });

  it("tells the operator how a space gets made when the bot has none", async () => {
    holder.client = createTestClient({ emptySpace: true });
    renderData(<DataTab agentSlug="designer" />, "/agents/designer/data");

    expect(await screen.findByText("No data yet")).toBeInTheDocument();
    expect(screen.getByText(/Ask it to track something/)).toBeInTheDocument();
  });
});
