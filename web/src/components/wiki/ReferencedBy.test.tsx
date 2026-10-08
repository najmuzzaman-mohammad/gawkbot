import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ReferencedBy from "./ReferencedBy";

// Wiki avatars read each author's chosen look from the office roster
// (useMemberAvatar). These tests are about the wiki surface, so stub that
// read rather than mounting a QueryClient for it.
vi.mock("../../hooks/useMembers", () => ({
  useMemberAvatar: () => undefined,
}));

const BACKLINKS = [
  { path: "playbooks/churn", title: "Churn prevention", author_slug: "cmo" },
  { path: "projects/q1", title: "Q1 retrospective", author_slug: "pm" },
];

describe("<ReferencedBy>", () => {
  it("renders the count badge and each backlink", () => {
    render(<ReferencedBy backlinks={BACKLINKS} />);
    expect(screen.getByTestId("wk-backlink-count")).toHaveTextContent("2");
    expect(screen.getByText("Churn prevention")).toBeInTheDocument();
    expect(screen.getByText("Q1 retrospective")).toBeInTheDocument();
  });

  it("calls onNavigate when a backlink is clicked", () => {
    const onNavigate = vi.fn();
    render(<ReferencedBy backlinks={BACKLINKS} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByText("Q1 retrospective"));
    expect(onNavigate).toHaveBeenCalledWith("projects/q1");
  });
});
