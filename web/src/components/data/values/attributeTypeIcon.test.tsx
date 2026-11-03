import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ATTRIBUTE_TYPES } from "../../../api/dataspaces";
import {
  AttributeTypeIcon,
  attributeTypeIcon,
  objectTypeIcon,
} from "./attributeTypeIcon";

describe("attributeTypeIcon", () => {
  it("resolves every modelled attribute type", () => {
    for (const type of ATTRIBUTE_TYPES) {
      expect(typeof attributeTypeIcon(type)).not.toBe("undefined");
    }
  });

  // The store owns the attribute-type set, so a newer broker can name one
  // this bundle has never seen. Answering `undefined` here made React throw
  // "Element type is invalid" and took the column header down with it.
  it("falls back to an icon for a type it does not know", () => {
    const fallback = attributeTypeIcon("geo_point");
    expect(fallback).toBe(attributeTypeIcon("also_not_a_type"));
    expect(fallback).not.toBe(attributeTypeIcon("text"));
    const { container } = render(<AttributeTypeIcon type="text" />);
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("renders an svg for an unknown type rather than throwing", () => {
    const Unknown = attributeTypeIcon("geo_point");
    const { container } = render(<Unknown aria-hidden="true" />);
    expect(container.querySelector("svg")).not.toBeNull();
  });
});

describe("objectTypeIcon", () => {
  it("falls back to a neutral box for an unknown or empty key", () => {
    expect(objectTypeIcon("")).toBe(objectTypeIcon("not-an-icon"));
    expect(objectTypeIcon("USER")).toBe(objectTypeIcon("user"));
  });
});
