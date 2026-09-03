import { describe, expect, it } from "vitest";

import { formatBotName } from "./botName";

describe("formatAgentName", () => {
  it("uppercases 2-3 character slugs (role abbreviations)", () => {
    expect(formatBotName("ceo")).toBe("CEO");
    expect(formatBotName("pm")).toBe("PM");
    expect(formatBotName("cro")).toBe("CRO");
    expect(formatBotName("seo")).toBe("SEO");
  });

  it("title-cases longer slugs", () => {
    expect(formatBotName("operator")).toBe("Operator");
    expect(formatBotName("planner")).toBe("Planner");
    expect(formatBotName("builder")).toBe("Builder");
    expect(formatBotName("reviewer")).toBe("Reviewer");
    expect(formatBotName("designer")).toBe("Designer");
  });

  it("title-cases each segment of hyphenated slugs", () => {
    expect(formatBotName("eng-1")).toBe("Eng-1");
    expect(formatBotName("product-manager")).toBe("Product-Manager");
    expect(formatBotName("ops-lead-2")).toBe("Ops-Lead-2");
  });

  it("returns empty string for empty input", () => {
    expect(formatBotName("")).toBe("");
  });

  it("handles already-capitalized input consistently", () => {
    // Short: always upper
    expect(formatBotName("CEO")).toBe("CEO");
    // Long: normalize to Title Case
    expect(formatBotName("OPERATOR")).toBe("Operator");
    expect(formatBotName("Operator")).toBe("Operator");
  });
});
