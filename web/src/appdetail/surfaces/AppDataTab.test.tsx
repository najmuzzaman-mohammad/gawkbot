import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppDataTab, compareByColumn, rowMatchesQuery } from "./AppDataTab";

// vi.mock is hoisted above this file's const declarations, so the mock handle
// must be hoisted too or the factory hits the TDZ.
const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("../../api/client", () => ({
  get,
  post,
}));

function wrap(node: ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

describe("AppDataTab", () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
  });

  it("reads the app DB directly (GET /apps/{id}/db, no AI call)", async () => {
    get.mockResolvedValue({ tables: [] });
    wrap(<AppDataTab appId="app_abc" />);
    await waitFor(() => expect(get).toHaveBeenCalledWith("/apps/app_abc/db"));
    // Two deterministic reads and no more: which store this app uses, then
    // that store. Still no /apps/ai derivation — the tab shows what the app
    // persisted, never a reconstruction of it.
    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledWith("/apps/app_abc/data-space");
    expect(get.mock.calls.every(([p]) => !String(p).includes("/apps/ai"))).toBe(
      true,
    );
  });

  it("shows an empty state when the app has no tables yet", async () => {
    get.mockResolvedValue({ tables: [] });
    const { getByText } = wrap(<AppDataTab appId="app_abc" />);
    await waitFor(() => expect(getByText(/no data yet/i)).toBeTruthy());
  });

  it("renders each table with typed headers and row values", async () => {
    get.mockResolvedValue({
      tables: [
        {
          name: "Emails",
          columns: [
            { name: "sender", type: "string" },
            { name: "urgency", type: "number" },
          ],
          rows: [
            { sender: "a@b.com", urgency: 72 },
            { sender: "c@d.com", urgency: 15 },
          ],
        },
      ],
    });
    const { getByText, getAllByText } = wrap(<AppDataTab appId="app_abc" />);
    await waitFor(() => expect(getByText("Emails")).toBeTruthy());
    expect(getByText("sender")).toBeTruthy();
    expect(getByText("urgency")).toBeTruthy();
    // Typed header shows the column type.
    expect(getAllByText("number").length).toBeGreaterThan(0);
    expect(getByText("a@b.com")).toBeTruthy();
    expect(getByText("2 rows")).toBeTruthy();
  });

  it("renders a bare date as a local calendar date, not a TZ-shifted timestamp", async () => {
    get.mockResolvedValue({
      tables: [
        {
          name: "Accounts",
          columns: [{ name: "renewalDate", type: "date" }],
          rows: [{ renewalDate: "2026-09-16" }],
        },
      ],
    });
    const { getByText } = wrap(<AppDataTab appId="app_abc" />);
    // "2026-09-16" must stay Sep 16 in every timezone (UTC-midnight parsing
    // used to render it as the previous local day with a bogus 5:00 PM).
    await waitFor(() => expect(getByText(/Sep 16, 2026/)).toBeTruthy());
  });

  it("frames the populated view as the bot's own exportable database", async () => {
    get.mockResolvedValue({
      tables: [
        {
          name: "Emails",
          columns: [{ name: "sender", type: "string" }],
          rows: [{ sender: "a@b.com" }],
        },
      ],
    });
    const { getByText } = wrap(<AppDataTab appId="app_abc" />);
    await waitFor(() => expect(getByText("Emails")).toBeTruthy());
    expect(getByText("This app’s database")).toBeTruthy();
    expect(getByText(/no export ticket/i)).toBeTruthy();
  });

  it("shows a defined-but-empty note for a table with no rows", async () => {
    get.mockResolvedValue({
      tables: [
        { name: "Log", columns: [{ name: "msg", type: "string" }], rows: [] },
      ],
    });
    const { getByText } = wrap(<AppDataTab appId="app_abc" />);
    await waitFor(() =>
      expect(getByText(/defined, no rows yet/i)).toBeTruthy(),
    );
  });

  it("drops malformed row entries (null, array) without crashing", async () => {
    get.mockResolvedValue({
      tables: [
        {
          name: "Emails",
          columns: [{ name: "sender", type: "string" }],
          rows: [null, ["not", "a", "row"], { sender: "a@b.com" }],
        },
      ],
    });
    const { getByText } = wrap(<AppDataTab appId="app_abc" />);
    await waitFor(() => expect(getByText("Emails")).toBeTruthy());
    // Only the plain-object row survives; the tab renders instead of crashing.
    expect(getByText("a@b.com")).toBeTruthy();
    expect(getByText("1 row")).toBeTruthy();
  });

  it("shows an error state when the DB read fails", async () => {
    get.mockRejectedValue(new Error("boom"));
    const { getByText } = wrap(<AppDataTab appId="app_abc" />);
    await waitFor(() =>
      expect(getByText(/could not read this app’s data/i)).toBeTruthy(),
    );
  });

  it("renders numbers grouped and right-aligned, booleans as a badge", async () => {
    get.mockResolvedValue({
      tables: [
        {
          name: "Products",
          columns: [
            { name: "stock", type: "number" },
            { name: "perishable", type: "string" },
          ],
          rows: [{ stock: 8400, perishable: true }],
        },
      ],
    });
    const { getByText } = wrap(<AppDataTab appId="app_abc" />);
    await waitFor(() => expect(getByText("Products")).toBeTruthy());
    // 8400 -> grouped "8,400" (locale-dependent separator, but the digits group)
    expect(getByText(/8.400/)).toBeTruthy();
    // boolean renders as a Yes badge, not raw "true"
    expect(getByText("Yes")).toBeTruthy();
  });

  it("filters visible rows by the search box", async () => {
    get.mockResolvedValue({
      tables: [
        {
          name: "Accounts",
          columns: [{ name: "name", type: "string" }],
          // >8 rows so the search toolbar renders.
          rows: Array.from({ length: 10 }, (_, i) => ({
            name: i === 3 ? "Meridian Health" : `Filler ${i}`,
          })),
        },
      ],
    });
    const { getByText, getByLabelText, queryByText } = wrap(
      <AppDataTab appId="app_abc" />,
    );
    await waitFor(() => expect(getByText("Meridian Health")).toBeTruthy());
    fireEvent.change(getByLabelText("Search Accounts"), {
      target: { value: "meridian" },
    });
    await waitFor(() => expect(queryByText("Filler 0")).toBeNull());
    expect(getByText("Meridian Health")).toBeTruthy();
    expect(getByText("1 of 10 rows")).toBeTruthy();
  });

  it("paginates a large table and advances pages", async () => {
    get.mockResolvedValue({
      tables: [
        {
          name: "Rows",
          columns: [{ name: "n", type: "number" }],
          rows: Array.from({ length: 30 }, (_, i) => ({ n: i })),
        },
      ],
    });
    const { getByText, queryByText } = wrap(<AppDataTab appId="app_abc" />);
    await waitFor(() => expect(getByText("Showing 1–25 of 30")).toBeTruthy());
    // Row 25 (0-indexed) is on page 2, not shown yet.
    expect(queryByText("25")).toBeNull();
    fireEvent.click(getByText("Next"));
    await waitFor(() => expect(getByText("Showing 26–30 of 30")).toBeTruthy());
    expect(getByText("25")).toBeTruthy();
  });
});

// ── The two modes ───────────────────────────────────────────────────────────
//
// Which store the tab reads is decided by the app's manifest, not by the tab.
// The per-app view above is what EVERY app with no space attached still gets;
// these cover the attached case and the switch between them.

describe("AppDataTab with a data space attached", () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
  });

  /** Wire the two reads the space mode makes. */
  function seedSpace(): void {
    get.mockImplementation(async (path: string) => {
      if (path === "/apps/app_abc/data-space") return { space_id: "space_1" };
      if (path === "/data/spaces/space_1") {
        return {
          space: { id: "space_1", name: "Seed raise", owner: "cos" },
          object_types: [
            {
              slug: "investor",
              name: "Investor",
              name_plural: "Investors",
              record_count: 2,
              attributes: [
                { slug: "name", name: "Name", type: "text" },
                {
                  slug: "stage",
                  name: "Stage",
                  type: "status",
                  options: [{ id: "opt_1", name: "Pitched" }],
                },
              ],
            },
            {
              slug: "firm",
              name: "Firm",
              name_plural: "Firms",
              record_count: 1,
              attributes: [{ slug: "name", name: "Name", type: "text" }],
            },
          ],
        };
      }
      throw new Error(`unexpected GET ${path}`);
    });
    post.mockResolvedValue({
      records: [
        { id: "rec_1", values: { name: "Ada Lovelace", stage: "opt_1" } },
      ],
      total: 2,
    });
  }

  it("names the space, lists its object types, and links to the full space", async () => {
    seedSpace();
    const { getAllByText, getByText, getByRole } = wrap(
      <AppDataTab appId="app_abc" />,
    );
    await waitFor(() => expect(getByText("Seed raise")).toBeTruthy());
    expect(getByText(/owned by @cos/)).toBeTruthy();
    expect(
      getByRole("link", { name: /Open Seed raise in Data/ }),
    ).toHaveAttribute("href", "/data/space_1");
    // "Investors" is both the selector button and the open block's heading.
    expect(getAllByText("Investors").length).toBeGreaterThan(0);
    expect(getByText("Firms")).toBeTruthy();
  });

  it("shows the first type's records, resolving option ids to names", async () => {
    seedSpace();
    const { getByText } = wrap(<AppDataTab appId="app_abc" />);
    await waitFor(() => expect(getByText("Ada Lovelace")).toBeTruthy());
    expect(post).toHaveBeenCalledWith("/data/spaces/space_1/records/query", {
      object_type: "investor",
      limit: 25,
    });
    // A status value is stored as an option id; showing "opt_1" would be
    // honest and useless.
    expect(getByText("Pitched")).toBeTruthy();
    expect(getByText("1 of 2 records")).toBeTruthy();
  });

  it("queries the type the operator picks", async () => {
    seedSpace();
    const { getByText } = wrap(<AppDataTab appId="app_abc" />);
    await waitFor(() => expect(getByText("Firms")).toBeTruthy());
    fireEvent.click(getByText("Firms"));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/data/spaces/space_1/records/query", {
        object_type: "firm",
        limit: 25,
      }),
    );
  });

  it("never reads the per-app tables when a space is attached", async () => {
    seedSpace();
    const { getByText } = wrap(<AppDataTab appId="app_abc" />);
    await waitFor(() => expect(getByText("Seed raise")).toBeTruthy());
    // Two sources of truth for one app is exactly what the space replaces.
    expect(
      get.mock.calls.every(([p]) => String(p) !== "/apps/app_abc/db"),
    ).toBe(true);
  });

  it("falls back to the per-app view when the binding cannot be read", async () => {
    get.mockImplementation(async (path: string) => {
      if (path === "/apps/app_abc/data-space") throw new Error("offline");
      return {
        tables: [
          {
            name: "Emails",
            columns: [{ name: "sender", type: "string" }],
            rows: [{ sender: "a@b.com" }],
          },
        ],
      };
    });
    const { getByText } = wrap(<AppDataTab appId="app_abc" />);
    // A failed lookup degrades to what every app had before data spaces, not
    // to an error the operator cannot act on.
    await waitFor(() =>
      expect(getByText("This app\u2019s database")).toBeTruthy(),
    );
    expect(getByText("a@b.com")).toBeTruthy();
  });

  it("shows an error state when the attached space cannot be loaded", async () => {
    get.mockImplementation(async (path: string) => {
      if (path === "/apps/app_abc/data-space") return { space_id: "space_1" };
      throw new Error("boom");
    });
    const { getByText } = wrap(<AppDataTab appId="app_abc" />);
    await waitFor(() =>
      expect(getByText(/could not read the attached data space/i)).toBeTruthy(),
    );
  });
});

describe("compareByColumn", () => {
  const numCol = { name: "n", type: "number" };
  const strCol = { name: "s", type: "string" };
  const dateCol = { name: "d", type: "date" };

  it("orders a number column numerically, not lexically", () => {
    const rows = [{ n: 10 }, { n: 9 }, { n: 2 }];
    const asc = [...rows].sort((a, b) => compareByColumn(a, b, numCol, "asc"));
    expect(asc.map((r) => r.n)).toEqual([2, 9, 10]);
  });

  it("orders a date column chronologically", () => {
    const rows = [
      { d: "2026-09-16" },
      { d: "2026-01-02" },
      { d: "2026-05-01" },
    ];
    const asc = [...rows].sort((a, b) => compareByColumn(a, b, dateCol, "asc"));
    expect(asc.map((r) => r.d)).toEqual([
      "2026-01-02",
      "2026-05-01",
      "2026-09-16",
    ]);
  });

  it("sorts empty values last regardless of direction", () => {
    const rows = [{ s: "" }, { s: "beta" }, { s: "alpha" }];
    const asc = [...rows].sort((a, b) => compareByColumn(a, b, strCol, "asc"));
    expect(asc.map((r) => r.s)).toEqual(["alpha", "beta", ""]);
    const desc = [...rows].sort((a, b) =>
      compareByColumn(a, b, strCol, "desc"),
    );
    expect(desc[desc.length - 1].s).toBe("");
  });
});

describe("rowMatchesQuery", () => {
  const cols = [
    { name: "name", type: "string" },
    { name: "meta", type: "string" },
  ];
  it("matches a case-insensitive substring across columns", () => {
    expect(
      rowMatchesQuery({ name: "Meridian Health", meta: {} }, cols, "meridian"),
    ).toBe(true);
    expect(rowMatchesQuery({ name: "Acme", meta: {} }, cols, "zzz")).toBe(
      false,
    );
  });
  it("searches inside nested JSON cells", () => {
    expect(
      rowMatchesQuery({ name: "X", meta: { owner: "Priya" } }, cols, "priya"),
    ).toBe(true);
  });
  it("empty query matches everything", () => {
    expect(rowMatchesQuery({ name: "anything" }, cols, "  ")).toBe(true);
  });
});
