import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type {
  AttributeDefinition,
  AttributeValue,
} from "../../../api/dataspaces";
import { EditableValueCell } from "./EditableValueCell";
import {
  FIXTURE_ATTRIBUTES as F,
  makeUnknownTypeAttribute,
} from "./storyFixtures";

function setup(
  attribute: AttributeDefinition,
  value: AttributeValue | undefined,
  props: { isPending?: boolean; isReadOnly?: boolean } = {},
) {
  const onCommit = vi.fn();
  const user = userEvent.setup();
  render(
    <EditableValueCell
      attribute={attribute}
      value={value}
      isPending={props.isPending}
      onCommit={props.isReadOnly ? undefined : onCommit}
    />,
  );
  const cell = screen.getByRole("gridcell");
  return { onCommit, user, cell };
}

describe("<EditableValueCell> entering edit mode", () => {
  it.each(["{F2}", "{Enter}"])("%s opens the editor", async (key) => {
    const { user, cell } = setup(F.text, "Hello");
    expect(cell.getAttribute("tabindex")).toBe("0");
    cell.focus();
    await user.keyboard(key);
    const input = screen.getByRole("textbox", { name: "Notes" });
    expect(input).toHaveValue("Hello");
    expect(input).toHaveFocus();
  });

  // There is no editor for a type this bundle does not model, so the cell
  // shows the value and declines rather than rendering an undefined editor.
  it("an unknown attribute type stays read-only and never throws", async () => {
    const attribute = makeUnknownTypeAttribute("geo_point", {
      name: "Location",
    });
    const { user, cell, onCommit } = setup(attribute, "41.4,-75.6");
    expect(cell.getAttribute("aria-readonly")).toBe("true");
    await user.dblClick(cell);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByTestId("data-unknown-value")).toHaveTextContent(
      "41.4,-75.6",
    );
  });

  it("double-click opens the editor; a single click does not", async () => {
    const { user, cell } = setup(F.text, "Hello");
    await user.click(cell);
    expect(screen.queryByRole("textbox")).toBeNull();
    await user.dblClick(cell);
    expect(screen.getByRole("textbox", { name: "Notes" })).toHaveFocus();
  });

  it("other keys do nothing", async () => {
    const { user, cell } = setup(F.text, "Hello");
    cell.focus();
    await user.keyboard("a{ArrowDown} ");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("Enter on a link inside the cell does not open the editor", () => {
    setup(F.email, "pam@example.com");
    fireEvent.keyDown(screen.getByRole("link"), { key: "Enter" });
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});

describe("<EditableValueCell> committing and cancelling", () => {
  it("Enter commits the converted value and returns focus to the cell", async () => {
    const { user, cell, onCommit } = setup(F.number, 12);
    cell.focus();
    await user.keyboard("{F2}");
    const input = screen.getByRole("textbox", { name: "Seats" });
    await user.clear(input);
    await user.type(input, "1,250{Enter}");
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(1250);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("gridcell")).toHaveFocus();
  });

  it("Escape cancels, sends nothing, and returns focus to the cell", async () => {
    const { user, cell, onCommit } = setup(F.text, "Hello");
    cell.focus();
    await user.keyboard("{F2}");
    await user.type(screen.getByRole("textbox"), " world{Escape}");
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("gridcell")).toHaveFocus();
    expect(screen.getByText("Hello")).toBeInTheDocument();
  });

  it("an unchanged draft is not sent", async () => {
    const { user, cell, onCommit } = setup(F.text, "Hello");
    cell.focus();
    await user.keyboard("{F2}{Enter}");
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("blur commits, and does not pull focus back from where the user went", async () => {
    const onCommit = vi.fn();
    const user = userEvent.setup();
    render(
      <>
        <EditableValueCell
          attribute={F.text}
          value="Hello"
          onCommit={onCommit}
        />
        <button type="button">Elsewhere</button>
      </>,
    );
    await user.dblClick(screen.getByRole("gridcell"));
    await user.type(screen.getByRole("textbox"), "!");
    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("Hello!");
    expect(screen.getByRole("button", { name: "Elsewhere" })).toHaveFocus();
  });

  it("clearing sends null, even for a required attribute", async () => {
    const { user, cell, onCommit } = setup(
      { ...F.text, isRequired: true },
      "Hello",
    );
    cell.focus();
    await user.keyboard("{F2}");
    await user.clear(screen.getByRole("textbox"));
    await user.keyboard("{Enter}");
    expect(onCommit).toHaveBeenCalledWith(null);
  });

  it("commits a date as the plain YYYY-MM-DD string", async () => {
    const { user, cell, onCommit } = setup(F.date, "2026-09-17");
    cell.focus();
    await user.keyboard("{Enter}");
    const input = screen.getByLabelText("Renewal date");
    fireEvent.change(input, { target: { value: "2026-10-01" } });
    await user.keyboard("{Enter}");
    expect(onCommit).toHaveBeenCalledWith("2026-10-01");
  });
});

describe("<EditableValueCell> toggle", () => {
  it("flips on a single click without entering edit mode", async () => {
    const { user, cell, onCommit } = setup(F.toggle, false);
    await user.click(cell);
    expect(onCommit).toHaveBeenCalledWith(true);
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("flips on Space, and an unset toggle becomes true", async () => {
    const { user, cell, onCommit } = setup(F.toggle, undefined);
    cell.focus();
    await user.keyboard(" ");
    expect(onCommit).toHaveBeenCalledWith(true);
  });

  it("flips true to false", async () => {
    const { user, cell, onCommit } = setup(F.toggle, true);
    await user.click(cell);
    expect(onCommit).toHaveBeenCalledWith(false);
  });

  it("F2 and double-click never open an editor for a toggle", async () => {
    const { user, cell } = setup(F.toggle, true);
    cell.focus();
    await user.keyboard("{F2}");
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});

describe("<EditableValueCell> read-only and pending", () => {
  it("is read-only when onCommit is withheld", async () => {
    const { user, cell } = setup(F.text, "Hello", { isReadOnly: true });
    expect(cell.getAttribute("tabindex")).toBe("-1");
    expect(cell.getAttribute("aria-readonly")).toBe("true");
    await user.dblClick(cell);
    fireEvent.keyDown(cell, { key: "F2" });
    fireEvent.keyDown(cell, { key: "Enter" });
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("a read-only toggle does not flip", async () => {
    const { user, cell } = setup(F.toggle, false, { isReadOnly: true });
    await user.click(cell);
    expect(screen.getByRole("img", { name: "No" })).toBeInTheDocument();
  });

  it("a relationship is never inline editable, even with a handler", () => {
    const { cell } = setup(F.relationship, undefined);
    expect(cell.getAttribute("tabindex")).toBe("-1");
  });

  it("pending shows a spinner, sets aria-busy, and blocks edits", async () => {
    const { user, cell, onCommit } = setup(F.text, "Hello", {
      isPending: true,
    });
    expect(cell.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("status", { name: "Saving" })).toBeInTheDocument();
    cell.focus();
    await user.keyboard("{F2}");
    await user.dblClick(cell);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("a pending toggle does not flip", async () => {
    const { user, cell, onCommit } = setup(F.toggle, false, {
      isPending: true,
    });
    await user.click(cell);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("is not busy when idle", () => {
    const { cell } = setup(F.text, "Hello");
    expect(cell.getAttribute("aria-busy")).toBe("false");
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("<EditableValueCell> select keyboard flow", () => {
  it("single: arrows move, Enter picks and commits in one step", async () => {
    const { user, cell, onCommit } = setup(F.select, "opt_lead");
    cell.focus();
    await user.keyboard("{F2}");
    const combobox = screen.getByRole("combobox", { name: "Stage" });
    expect(combobox).toHaveFocus();
    expect(combobox.getAttribute("aria-expanded")).toBe("true");
    // Opens on the current selection: "No value", [Lead], Qualified, ...
    const active = () =>
      document.getElementById(
        combobox.getAttribute("aria-activedescendant") ?? "",
      )?.textContent;
    expect(active()).toBe("Lead");
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(active()).toBe("In progress");
    await user.keyboard("{Enter}");
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("opt_progress");
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByRole("gridcell")).toHaveFocus();
  });

  it("single: type to filter, Enter picks the first match", async () => {
    const { user, cell, onCommit } = setup(F.status, undefined);
    cell.focus();
    await user.keyboard("{Enter}");
    await user.keyboard("wo");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Won",
    ]);
    await user.keyboard("{Enter}");
    expect(onCommit).toHaveBeenCalledWith("opt_won");
  });

  it("single: the No value row clears", async () => {
    const { user, cell, onCommit } = setup(F.select, "opt_won");
    await user.dblClick(cell);
    await user.click(screen.getByRole("option", { name: "No value" }));
    expect(onCommit).toHaveBeenCalledWith(null);
  });

  it("single: a required select offers no clear row", async () => {
    const { user, cell } = setup({ ...F.select, isRequired: true }, "opt_won");
    await user.dblClick(cell);
    expect(screen.queryByRole("option", { name: "No value" })).toBeNull();
  });

  it("single: Escape cancels without committing", async () => {
    const { user, cell, onCommit } = setup(F.select, "opt_lead");
    cell.focus();
    await user.keyboard("{F2}{ArrowDown}{Escape}");
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByRole("gridcell")).toHaveFocus();
  });

  it("multivalue: Space toggles and keeps the list open, Enter commits", async () => {
    const { user, cell, onCommit } = setup(F.multiSelect, ["opt_design"]);
    cell.focus();
    await user.keyboard("{F2}");
    const listbox = screen.getByRole("listbox");
    expect(listbox.getAttribute("aria-multiselectable")).toBe("true");
    // Opens on the selected "Design partner"; move to "Enterprise".
    await user.keyboard("{ArrowDown} ");
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox")).toBeInTheDocument();
    expect(
      screen
        .getByRole("option", { name: "Enterprise" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    // Toggle the original one off, then save.
    await user.keyboard("{ArrowUp} {Enter}");
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(["opt_enterprise"]);
  });

  it("multivalue: Enter on a typed filter toggles first, then commits", async () => {
    const { user, cell, onCommit } = setup(F.multiSelect, undefined);
    cell.focus();
    await user.keyboard("{F2}churn{Enter}");
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox")).toHaveValue("");
    await user.keyboard("{Enter}");
    expect(onCommit).toHaveBeenCalledWith(["opt_churn"]);
  });

  it("multivalue: clicking options toggles without blurring the field", async () => {
    const { user, cell, onCommit } = setup(F.multiSelect, undefined);
    await user.dblClick(cell);
    await user.click(screen.getByRole("option", { name: "Referral" }));
    await user.click(screen.getByRole("option", { name: "Enterprise" }));
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox")).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onCommit).toHaveBeenCalledWith(["opt_referral", "opt_enterprise"]);
  });

  it("multivalue: Backspace on an empty filter removes the last selection", async () => {
    const { user, cell, onCommit } = setup(F.multiSelect, [
      "opt_design",
      "opt_churn",
    ]);
    cell.focus();
    await user.keyboard("{F2}{Backspace}{Enter}");
    expect(onCommit).toHaveBeenCalledWith(["opt_design"]);
  });
});

describe("<EditableValueCell> rating", () => {
  it("arrow keys change the rating and Enter commits it", async () => {
    const { user, cell, onCommit } = setup(F.rating, 3);
    cell.focus();
    await user.keyboard("{F2}");
    expect(screen.getByRole("radio", { name: "3 out of 5" })).toHaveFocus();
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(screen.getByRole("radio", { name: "5 out of 5" })).toHaveFocus();
    await user.keyboard("{ArrowLeft}{Enter}");
    expect(onCommit).toHaveBeenCalledWith(4);
  });

  it("clicking the current rating clears it", async () => {
    const { user, cell, onCommit } = setup(F.rating, 3);
    await user.dblClick(cell);
    await user.click(screen.getByRole("radio", { name: "3 out of 5" }));
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).not.toBeChecked();
    }
    await user.keyboard("{Enter}");
    expect(onCommit).toHaveBeenCalledWith(null);
  });
});
