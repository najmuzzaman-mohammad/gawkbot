import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FIXTURE_ATTRIBUTES as F } from "./storyFixtures";
import { VALUE_CELL_RENDERERS, ValueCell } from "./ValueCell";

describe("<ValueCell>", () => {
  it("has a renderer for every displayable type", () => {
    expect(Object.keys(VALUE_CELL_RENDERERS).sort()).toEqual(
      [
        "currency",
        "date",
        "email",
        "number",
        "phone",
        "rating",
        "select",
        "status",
        "text",
        "toggle",
        "url",
      ].sort(),
    );
  });

  it("renders nothing for a relationship", () => {
    const { container } = render(
      <ValueCell attribute={F.relationship} value="x" />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("normalizes a bare URL to https and hides the protocol", () => {
    render(<ValueCell attribute={F.url} value="example.com/paper" />);
    const link = screen.getByRole("link", { name: "example.com/paper" });
    expect(link.getAttribute("href")).toBe("https://example.com/paper");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("keeps an explicit protocol in the href", () => {
    render(<ValueCell attribute={F.url} value="http://example.com/" />);
    const link = screen.getByRole("link", { name: "example.com" });
    expect(link.getAttribute("href")).toBe("http://example.com/");
  });

  it("never turns a script URL into a link", () => {
    render(<ValueCell attribute={F.url} value="javascript:alert(1)" />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("javascript:alert(1)")).toBeInTheDocument();
  });

  it("links email with mailto and phone with tel", () => {
    render(
      <>
        <ValueCell attribute={F.email} value="pam@example.com" />
        <ValueCell attribute={F.phone} value="+1 (570) 555-0142" />
      </>,
    );
    expect(
      screen
        .getByRole("link", { name: "pam@example.com" })
        .getAttribute("href"),
    ).toBe("mailto:pam@example.com");
    expect(
      screen
        .getByRole("link", { name: "+1 (570) 555-0142" })
        .getAttribute("href"),
    ).toBe("tel:+15705550142");
  });

  it("stops a link click from reaching the row", () => {
    const onRowClick = vi.fn();
    render(
      <button type="button" onClick={onRowClick}>
        <ValueCell attribute={F.email} value="pam@example.com" />
      </button>,
    );
    const link = screen.getByRole("link");
    link.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(link);
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("truncatable text carries the full value as its title", () => {
    render(<ValueCell attribute={F.text} value="A long note" />);
    expect(screen.getByText("A long note").getAttribute("title")).toBe(
      "A long note",
    );
  });

  it("labels a rating for assistive tech", () => {
    render(<ValueCell attribute={F.rating} value={4} />);
    const rating = screen.getByRole("img", { name: "4 out of 5" });
    expect(rating.querySelectorAll('[data-filled="true"]')).toHaveLength(4);
    expect(rating.querySelectorAll('[data-filled="false"]')).toHaveLength(1);
  });

  it("shows a toggle as a labelled glyph, unchecked when never set", () => {
    const { rerender } = render(
      <ValueCell attribute={F.toggle} value={true} />,
    );
    expect(screen.getByRole("img", { name: "Yes" })).toBeInTheDocument();
    rerender(<ValueCell attribute={F.toggle} value={undefined} />);
    expect(screen.getByRole("img", { name: "No" })).toBeInTheDocument();
  });

  it("renders status options as pills with a leading dot", () => {
    const { container } = render(
      <ValueCell attribute={F.status} value="opt_won" />,
    );
    const pill = container.querySelector(".dv-pill");
    expect(pill?.className).toContain("dv-pill--green");
    expect(pill?.querySelector(".dv-pill__dot")).not.toBeNull();
    expect(pill?.textContent).toBe("Won");
  });

  it("renders every selected option of a multivalue select", () => {
    const { container } = render(
      <ValueCell
        attribute={F.multiSelect}
        value={["opt_design", "opt_churn"]}
      />,
    );
    expect(
      [...container.querySelectorAll(".dv-pill")].map((p) => p.textContent),
    ).toEqual(["Design partner", "Churn risk"]);
    expect(container.querySelector(".dv-pill__dot")).toBeNull();
  });

  it("uses a muted middle dot, never a dash, for an empty value", () => {
    const { container } = render(
      <ValueCell attribute={F.number} value={undefined} />,
    );
    expect(container.textContent).toBe("·");
    expect(container.textContent).not.toMatch(/[‒-―-]/);
  });

  it("right-aligns numerics through the numeric class", () => {
    const { container } = render(
      <ValueCell attribute={F.currency} value={48000} />,
    );
    const numeric = container.querySelector(".dv-numeric");
    expect(numeric?.textContent).toBe("$48,000");
  });
});
