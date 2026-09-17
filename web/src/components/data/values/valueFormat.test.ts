import { afterEach, describe, expect, it, vi } from "vitest";

import { ATTRIBUTE_TYPES, type AttributeValue } from "../../../api/dataspaces";
import { FIXTURE_ATTRIBUTES, makeAttribute } from "./storyFixtures";
import {
  attributeTypeLabel,
  displayUrl,
  draftToValue,
  formatValue,
  isEmptyValue,
  isInlineEditable,
  normalizeUrlHref,
  optionById,
  phoneHref,
  valueToDraft,
} from "./valueFormat";

const F = FIXTURE_ATTRIBUTES;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("formatValue", () => {
  const cases: ReadonlyArray<
    [string, keyof typeof F, AttributeValue | undefined, string]
  > = [
    ["text", "text", "Hello", "Hello"],
    ["number, whole", "number", 1250, "1,250"],
    ["number, fractional", "number", 0.375, "0.375"],
    ["number, zero is a value", "number", 0, "0"],
    ["currency, whole has no cents", "currency", 48000, "$48,000"],
    ["currency, fractional keeps cents", "currency", 1999.5, "$1,999.50"],
    ["date", "date", "2026-09-17", "Sep 17, 2026"],
    ["toggle true", "toggle", true, "Yes"],
    ["toggle false", "toggle", false, "No"],
    ["select", "select", "opt_qualified", "Qualified"],
    [
      "multivalue select",
      "multiSelect",
      ["opt_design", "opt_referral"],
      "Design partner, Referral",
    ],
    ["status", "status", "opt_progress", "In progress"],
    ["rating", "rating", 4, "4/5"],
    ["url", "url", "example.com/a", "example.com/a"],
    ["email", "email", "pam@example.com", "pam@example.com"],
    ["phone", "phone", "+1 570 555 0142", "+1 570 555 0142"],
    ["relationship carries no value", "relationship", "anything", ""],
  ];

  it.each(cases)("%s", (_label, key, value, expected) => {
    expect(formatValue(F[key], value)).toBe(expected);
  });

  it.each(
    Object.keys(F) as Array<keyof typeof F>,
  )("renders empty as an empty string for %s", (key) => {
    expect(formatValue(F[key], undefined)).toBe("");
    expect(formatValue(F[key], "")).toBe("");
  });

  it("defaults currency to USD and honours an explicit code", () => {
    expect(formatValue(makeAttribute("currency"), 310)).toBe("$310");
    expect(
      formatValue(makeAttribute("currency", { currencyCode: "EUR" }), 7200),
    ).toBe("€7,200");
  });

  it("degrades instead of throwing on a malformed currency code", () => {
    const attribute = makeAttribute("currency", { currencyCode: "DOLLARS" });
    expect(formatValue(attribute, 12)).toBe("DOLLARS 12");
  });

  it("drops option ids the attribute no longer defines", () => {
    expect(formatValue(F.multiSelect, ["opt_design", "opt_gone"])).toBe(
      "Design partner",
    );
  });

  it("returns an unparseable date as written", () => {
    expect(formatValue(F.date, "next tuesday")).toBe("next tuesday");
  });

  // The bug this guards: `new Date("2026-09-17")` is UTC midnight, which a
  // local-time formatter shows as Sep 16 anywhere west of Greenwich.
  it.each([
    "America/Los_Angeles",
    "Pacific/Kiritimati",
    "UTC",
  ])("does not shift the calendar day in %s", (timeZone) => {
    vi.stubEnv("TZ", timeZone);
    expect(formatValue(F.date, "2026-09-17")).toBe("Sep 17, 2026");
    expect(formatValue(F.date, "2026-01-01")).toBe("Jan 1, 2026");
    expect(formatValue(F.date, "2026-12-31")).toBe("Dec 31, 2026");
  });

  it("keeps the day when the stored date carries a time part", () => {
    expect(formatValue(F.date, "2026-09-17T23:30:00-08:00")).toBe(
      "Sep 17, 2026",
    );
  });
});

describe("isEmptyValue", () => {
  it.each([
    [undefined, true],
    [null, true],
    ["", true],
    ["   ", true],
    [[], true],
    [Number.NaN, true],
    ["x", false],
    [0, false],
    [false, false],
    [true, false],
    [["opt_a"], false],
  ] as ReadonlyArray<
    [AttributeValue | null | undefined, boolean]
  >)("%j -> %s", (value, expected) => {
    expect(isEmptyValue(value)).toBe(expected);
  });
});

describe("valueToDraft and draftToValue", () => {
  const roundTrips: ReadonlyArray<[keyof typeof F, AttributeValue, string]> = [
    ["text", "Hello", "Hello"],
    ["number", 1250.5, "1250.5"],
    ["number", 0, "0"],
    ["currency", 48000, "48000"],
    ["date", "2026-09-17", "2026-09-17"],
    ["toggle", true, "true"],
    ["toggle", false, "false"],
    ["select", "opt_won", "opt_won"],
    ["multiSelect", ["opt_design", "opt_churn"], "opt_design,opt_churn"],
    ["status", "opt_lost", "opt_lost"],
    ["rating", 3, "3"],
    ["url", "example.com", "example.com"],
    ["email", "pam@example.com", "pam@example.com"],
    ["phone", "+1 570 555 0142", "+1 570 555 0142"],
  ];

  it.each(roundTrips)("%s %j round-trips through %j", (key, value, draft) => {
    expect(valueToDraft(F[key], value)).toBe(draft);
    expect(draftToValue(F[key], draft)).toEqual(value);
  });

  it.each(
    Object.keys(F) as Array<keyof typeof F>,
  )("an empty %s draft means clear", (key) => {
    expect(valueToDraft(F[key], undefined)).toBe("");
    expect(draftToValue(F[key], "")).toBeNull();
    expect(draftToValue(F[key], "   ")).toBeNull();
  });

  it("trims text and accepts grouped digits", () => {
    expect(draftToValue(F.text, "  hi  ")).toBe("hi");
    expect(draftToValue(F.number, "1,250")).toBe(1250);
  });

  it("passes an unparseable number through for the client to reject", () => {
    expect(draftToValue(F.number, "12abc")).toBe("12abc");
    expect(draftToValue(F.currency, "lots")).toBe("lots");
  });

  it("a single select keeps only the first id; multivalue keeps an array", () => {
    expect(draftToValue(F.select, "opt_won,opt_lost")).toBe("opt_won");
    expect(draftToValue(F.multiSelect, "opt_design")).toEqual(["opt_design"]);
    expect(draftToValue(F.multiSelect, ",")).toBeNull();
  });

  it("never produces a relationship value", () => {
    expect(draftToValue(F.relationship, "rec_1")).toBeNull();
  });
});

describe("attribute helpers", () => {
  it("labels every attribute type", () => {
    expect(ATTRIBUTE_TYPES.map(attributeTypeLabel)).toEqual([
      "Text",
      "Number",
      "Currency",
      "Date",
      "Checkbox",
      "Select",
      "Status",
      "Rating",
      "URL",
      "Email",
      "Phone",
      "Relation",
    ]);
  });

  it("only relationships are not inline editable", () => {
    for (const type of ATTRIBUTE_TYPES) {
      expect(isInlineEditable(makeAttribute(type))).toBe(
        type !== "relationship",
      );
    }
  });

  it("finds an option by id", () => {
    expect(optionById(F.select, "opt_won")?.name).toBe("Won");
    expect(optionById(F.select, "opt_missing")).toBeUndefined();
  });
});

describe("link helpers", () => {
  it.each([
    ["example.com", "https://example.com"],
    ["https://example.com/a", "https://example.com/a"],
    ["HTTP://example.com", "HTTP://example.com"],
    ["localhost:3000/x", "https://localhost:3000/x"],
    ["", ""],
    ["javascript:alert(1)", ""],
    ["data:text/html,<script>1</script>", ""],
  ])("normalizeUrlHref(%j) -> %j", (raw, expected) => {
    expect(normalizeUrlHref(raw)).toBe(expected);
  });

  it("shows a URL without protocol or trailing slash", () => {
    expect(displayUrl("https://example.com/")).toBe("example.com");
    expect(displayUrl("example.com/a")).toBe("example.com/a");
  });

  it("builds a tel href from digits and a leading plus", () => {
    expect(phoneHref("+1 (570) 555-0142")).toBe("tel:+15705550142");
  });
});
