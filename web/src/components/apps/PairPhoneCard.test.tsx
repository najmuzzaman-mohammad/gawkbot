import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn(async () => "data:image/png;base64,QUJD") },
}));
vi.mock("../../api/client", () => ({
  pairingLink: () =>
    "gawkbot://pair?url=http%3A%2F%2F100.64.0.5%3A7890&token=tok",
  pairingLinkIsLocalOnly: () => false,
}));
vi.mock("../../api/platform", () => ({}));

import { PairPhoneCard } from "./HealthCheckApp";

// The gawkbot iOS app pairs by scanning this card. The code carries the
// office's full-access token, so it is host-only.
describe("PairPhoneCard", () => {
  it("renders a scannable code and a copyable link for the host", async () => {
    render(<PairPhoneCard isHost={true} />);
    expect(screen.getByText("Pair your phone")).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.getByAltText("Pairing code for the gawkbot iOS app"),
      ).toHaveAttribute("src", "data:image/png;base64,QUJD");
    });
    expect(
      screen.getByRole("button", { name: "Copy pairing link" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/open on/)).toBeNull();
  });

  it("does not show the code to a team member", () => {
    render(<PairPhoneCard isHost={false} />);
    expect(screen.getByText("Phone pairing is host-only.")).toBeInTheDocument();
    expect(
      screen.queryByAltText("Pairing code for the gawkbot iOS app"),
    ).toBeNull();
  });
});
