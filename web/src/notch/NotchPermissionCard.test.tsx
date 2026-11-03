import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { NotchPermissionCard, permissionsMissing } from "./NotchPermissionCard";

describe("the permissions card for bots on this Mac", () => {
  it("offers a button for each missing grant and a check for each given one", () => {
    const onRequest = vi.fn();
    render(
      <NotchPermissionCard
        permissions={{ accessibility: true, screen_recording: false }}
        onRequest={onRequest}
      />,
    );
    expect(screen.getByLabelText("Accessibility granted")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Allow Screen Recording" }),
    );
    expect(onRequest).toHaveBeenCalledWith("screen_recording");
    expect(
      screen.queryByRole("button", { name: "Allow Accessibility" }),
    ).toBeNull();
  });
  it("is nothing once both are given", () => {
    const { container } = render(
      <NotchPermissionCard
        permissions={{ accessibility: true, screen_recording: true }}
        onRequest={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(permissionsMissing(undefined)).toEqual([]);
    expect(
      permissionsMissing({ accessibility: false, screen_recording: false }),
    ).toEqual(["accessibility", "screen_recording"]);
  });
});
