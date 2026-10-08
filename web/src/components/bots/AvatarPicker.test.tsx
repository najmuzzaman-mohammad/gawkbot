import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { MemberAvatar } from "../../api/memberTypes";
import {
  AVATAR_SHAPES,
  BLOB_COLORS,
  blobColor,
  blobShapeIndex,
} from "../../lib/blobAvatar";
import { AvatarPicker } from "./AvatarPicker";

function Harness({
  slug = "cos",
  initial,
  onChange,
}: {
  slug?: string;
  initial?: MemberAvatar;
  onChange?: (next: MemberAvatar | undefined) => void;
}) {
  const [value, setValue] = useState<MemberAvatar | undefined>(initial);
  return (
    <AvatarPicker
      slug={slug}
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

const shapeGroup = () => screen.getByRole("group", { name: "Shape" });
const colorGroup = () => screen.getByRole("group", { name: "Colour" });

describe("<AvatarPicker>", () => {
  it("shows all eight shapes and the palette, with the derived look checked", () => {
    render(<Harness />);
    const shapes = within(shapeGroup()).getAllByRole("radio");
    expect(shapes).toHaveLength(AVATAR_SHAPES.length);
    const checked = within(shapeGroup()).getByRole("radio", { checked: true });
    expect(checked).toHaveAttribute(
      "value",
      AVATAR_SHAPES[blobShapeIndex("cos")],
    );
    // Every shape tile is a live preview of the bot.
    for (const radio of shapes) {
      expect(radio.closest("label")?.querySelector("svg")).not.toBeNull();
    }

    expect(within(colorGroup()).getAllByRole("radio")).toHaveLength(
      BLOB_COLORS.length,
    );
    expect(
      within(colorGroup()).getByRole("radio", { checked: true }),
    ).toHaveAttribute("value", blobColor("cos"));
    expect(screen.getByText("Automatic")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reset to automatic" }),
    ).toBeDisabled();
  });

  it("picking a shape sets only the shape", async () => {
    const onChange = vi.fn();
    // A shape other than the slug's own, which is already checked.
    const pick = AVATAR_SHAPES[(blobShapeIndex("cos") + 1) % 8];
    render(<Harness onChange={onChange} />);
    const radio = screen.getByRole("radio", {
      name: pick[0].toUpperCase() + pick.slice(1),
    });
    await userEvent.click(radio);
    expect(onChange).toHaveBeenLastCalledWith({ shape: pick });
    expect(radio).toBeChecked();
    expect(screen.getByText("Custom look")).toBeInTheDocument();
  });

  it("moves and selects with arrow keys, wrapping, as one radio group", async () => {
    const onChange = vi.fn();
    render(<Harness initial={{ shape: "block" }} onChange={onChange} />);
    const block = screen.getByRole("radio", { name: "Block" });
    // One shared name makes the eight inputs one group: one Tab stop.
    const names = new Set(
      within(shapeGroup())
        .getAllByRole("radio")
        .map((r) => r.getAttribute("name")),
    );
    expect(names.size).toBe(1);

    block.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith({ shape: "dome" });
    expect(screen.getByRole("radio", { name: "Dome" })).toHaveFocus();

    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(onChange).toHaveBeenLastCalledWith({ shape: "blob" });
    expect(screen.getByRole("radio", { name: "Blob" })).toHaveFocus();

    await userEvent.keyboard("{Home}");
    expect(onChange).toHaveBeenLastCalledWith({ shape: "block" });
    await userEvent.keyboard("{End}");
    expect(onChange).toHaveBeenLastCalledWith({ shape: "blob" });
  });

  it("picks palette and custom colours, keeping the shape", async () => {
    const onChange = vi.fn();
    render(<Harness initial={{ shape: "loaf" }} onChange={onChange} />);
    await userEvent.click(screen.getByRole("radio", { name: "Teal" }));
    expect(onChange).toHaveBeenLastCalledWith({
      shape: "loaf",
      color: "#3f9c8f",
    });

    fireEvent.change(screen.getByLabelText("Custom colour"), {
      target: { value: "#ABCDEF" },
    });
    expect(onChange).toHaveBeenLastCalledWith({
      shape: "loaf",
      color: "#abcdef",
    });
    // A custom colour checks nothing in the palette; the Custom chip is.
    expect(
      within(colorGroup()).queryByRole("radio", { checked: true }),
    ).toBeNull();
    expect(
      screen.getByLabelText("Custom colour").closest("label"),
    ).toHaveAttribute("data-checked", "true");
  });

  it("resets to automatic", async () => {
    const onChange = vi.fn();
    render(
      <Harness
        initial={{ shape: "drop", color: "#102030" }}
        onChange={onChange}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Reset to automatic" }),
    );
    expect(onChange).toHaveBeenLastCalledWith(undefined);
    expect(screen.getByText("Automatic")).toBeInTheDocument();
  });

  it("previews with the bot's slug, and copes with no slug yet", () => {
    const { rerender } = render(
      <AvatarPicker slug="" value={undefined} onChange={() => undefined} />,
    );
    expect(screen.getByRole("img", { name: /Avatar preview/ })).toBeVisible();
    rerender(
      <AvatarPicker
        slug="planner"
        value={undefined}
        onChange={() => undefined}
      />,
    );
    expect(
      within(shapeGroup()).getByRole("radio", { checked: true }),
    ).toHaveAttribute("value", AVATAR_SHAPES[blobShapeIndex("planner")]);
  });
});
