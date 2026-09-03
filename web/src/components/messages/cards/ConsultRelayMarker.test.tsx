import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  ConsultRelayMarker,
  parseConsultRelayPayload,
} from "./ConsultRelayMarker";

// The panel mounts a real MessageFeed, which fetches. Stub it: this file is
// about the marker and the read-only contract, not the feed's own behaviour.
// The stub records the props it was given so the read-only assertion is real
// rather than assumed.
const feedProps: Array<{ channel?: string; readOnly?: boolean }> = [];
vi.mock("../MessageFeed", () => ({
  MessageFeed: (props: { channel?: string; readOnly?: boolean }) => {
    feedProps.push(props);
    return <div data-testid="stub-feed" />;
  },
}));

vi.mock("../../../hooks/useMembers", () => ({
  useOfficeMembers: () => ({
    data: [{ slug: "social", name: "Bagel Social", role: "Social" }],
  }),
}));

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

describe("parseConsultRelayPayload", () => {
  it("keeps only well-formed fields", () => {
    expect(
      parseConsultRelayPayload({
        direction: "received",
        agent: " social ",
        channel: "ops__social",
      }),
    ).toEqual({
      direction: "received",
      agent: "social",
      channel: "ops__social",
    });
  });

  // The payload crosses a trust boundary like any other wire field; a bad
  // shape must degrade, never throw.
  it("survives junk", () => {
    expect(parseConsultRelayPayload(null)).toEqual({});
    expect(parseConsultRelayPayload("nope")).toEqual({});
    expect(parseConsultRelayPayload([1, 2])).toEqual({});
    expect(parseConsultRelayPayload({ direction: "sideways" })).toEqual({});
  });
});

describe("ConsultRelayMarker", () => {
  it("reads as an outbound line naming the peer", () => {
    wrap(
      <ConsultRelayMarker
        payload={{ direction: "sent", agent: "social", channel: "ops__social" }}
      />,
    );
    const marker = screen.getByTestId("consult-relay-marker");
    expect(marker).toHaveTextContent("Messaged");
    expect(marker).toHaveTextContent("Bagel Social");
    expect(marker).toHaveAttribute("data-direction", "sent");
  });

  it("reads as an inbound line for the reply", () => {
    wrap(
      <ConsultRelayMarker
        payload={{
          direction: "received",
          agent: "social",
          channel: "ops__social",
        }}
      />,
    );
    expect(screen.getByTestId("consult-relay-marker")).toHaveTextContent(
      "Message from",
    );
  });

  // The whole point: click through to check what was actually said.
  it("opens the real conversation READ-ONLY", () => {
    feedProps.length = 0;
    wrap(
      <ConsultRelayMarker
        payload={{ direction: "sent", agent: "social", channel: "ops__social" }}
      />,
    );
    fireEvent.click(screen.getByTestId("consult-relay-marker"));

    expect(screen.getByTestId("stub-feed")).toBeInTheDocument();
    expect(feedProps).toHaveLength(1);
    expect(feedProps[0].channel).toBe("ops__social");
    expect(feedProps[0].readOnly).toBe(true);
  });

  // Read-only means read-only: there must be no composer, and no textbox of
  // any kind that could imply you can join in.
  it("offers nothing to type into", () => {
    wrap(
      <ConsultRelayMarker
        payload={{ direction: "sent", agent: "social", channel: "ops__social" }}
      />,
    );
    fireEvent.click(screen.getByTestId("consult-relay-marker"));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByText(/read only/i)).toBeInTheDocument();
  });

  // Falls back to the slug rather than inventing a display name.
  it("uses the slug when the roster has no such bot", () => {
    wrap(
      <ConsultRelayMarker
        payload={{ direction: "sent", agent: "ghost", channel: "ops__ghost" }}
      />,
    );
    expect(screen.getByTestId("consult-relay-marker")).toHaveTextContent(
      "ghost",
    );
  });

  it("renders nothing without a peer, and cannot be clicked without a channel", () => {
    const { container } = wrap(<ConsultRelayMarker payload={{}} />);
    expect(container).toBeEmptyDOMElement();

    wrap(
      <ConsultRelayMarker payload={{ direction: "sent", agent: "social" }} />,
    );
    expect(screen.getByTestId("consult-relay-marker")).toBeDisabled();
  });
});
