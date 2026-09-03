import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ArtifactsTab } from "./ArtifactsTab";
import type { Artifact } from "./artifacts";

const ARTIFACTS: Artifact[] = [
  {
    id: "m1",
    type: "md",
    title: "weekly-summary.md",
    producedBy: "weeklyPipelineSummary",
    at: "Monday",
    content: "# Recap\n6 deals moved",
  },
  {
    id: "p1",
    type: "pdf",
    title: "brief.pdf",
    producedBy: "weeklyPipelineSummary",
    at: "Jun 30",
    size: "182 KB",
  },
];

describe("ArtifactsTab", () => {
  it("lists every artifact and opens the first one's viewer", () => {
    const { getByText } = render(
      <ArtifactsTab agentName="Pipeline Bot" artifacts={ARTIFACTS} />,
    );
    // All artifacts appear as chips (md + pdf).
    expect(getByText("weekly-summary.md")).toBeTruthy();
    expect(getByText("brief.pdf")).toBeTruthy();
    // The first artifact is selected and its viewer is rendered.
    expect(getByText(/6 deals moved/)).toBeTruthy();
  });

  it("switches viewer when another artifact is selected", () => {
    const { getByText, queryByText } = render(
      <ArtifactsTab agentName="Pipeline Bot" artifacts={ARTIFACTS} />,
    );
    // The pdf artifact shows the file card with a download affordance.
    fireEvent.click(getByText("brief.pdf"));
    expect(queryByText(/6 deals moved/)).toBeNull();
    expect(getByText("Download")).toBeTruthy();
    expect(getByText(/182 KB/)).toBeTruthy();
  });

  it("renders bot-authored html in a fully locked-down sandbox", () => {
    const html: Artifact = {
      id: "h1",
      type: "html",
      title: "lead-scores.html",
      producedBy: "scoreAndRouteLead",
      at: "yesterday",
      content: "<p>scores</p>",
    };
    const { container, getByText } = render(
      <ArtifactsTab
        agentName="Pipeline Bot"
        artifacts={[...ARTIFACTS, html]}
      />,
    );
    fireEvent.click(getByText("lead-scores.html"));
    const iframe = container.querySelector("iframe");
    expect(iframe).toBeTruthy();
    // The EMPTY sandbox attribute is the security boundary for bot-authored
    // HTML: no scripts, no navigation, no same-origin. Never loosen silently.
    expect(iframe?.getAttribute("sandbox")).toBe("");
  });

  it("disables the pdf download until the artifact has a url", () => {
    const { container, getByText, rerender } = render(
      <ArtifactsTab agentName="Pipeline Bot" artifacts={ARTIFACTS} />,
    );
    fireEvent.click(getByText("brief.pdf"));
    // No url yet (honest mock): the button is disabled and says why.
    const button = getByText("Download").closest("button");
    expect(button?.disabled).toBe(true);
    expect(button?.title).toBe("Not exported yet");

    // With a url the download is a real link.
    const exported = ARTIFACTS.map((a) =>
      a.id === "p1" ? { ...a, url: "/artifacts/brief.pdf" } : a,
    );
    rerender(<ArtifactsTab agentName="Pipeline Bot" artifacts={exported} />);
    const anchor = container.querySelector("a[download]");
    expect(anchor?.getAttribute("href")).toBe("/artifacts/brief.pdf");
  });

  it("humanizes ISO artifact timestamps and passes non-date stamps through", () => {
    const iso: Artifact = {
      id: "i1",
      type: "md",
      title: "recap.md",
      producedBy: "weeklyPipelineSummary",
      at: "2026-07-03T01:08:04.821Z",
      content: "# hi",
    };
    const { container, getByText } = render(
      <ArtifactsTab agentName="Pipeline Bot" artifacts={[iso, ...ARTIFACTS]} />,
    );
    const meta = container.querySelector(".opr-artifact-meta");
    // The raw ISO stamp never reaches the UI…
    expect(meta?.textContent).not.toContain("2026-07-03T01:08:04.821Z");
    // …it renders as a short local "Mon D" date.
    expect(meta?.textContent).toMatch(/[A-Z][a-z]{2}\s+\d{1,2}/);
    // A non-date stamp (a seeded label) is left untouched.
    expect(getByText(/weeklyPipelineSummary · Monday/)).toBeTruthy();
  });

  it("shows the honest empty state when nothing was produced yet", () => {
    const { getByText } = render(
      <ArtifactsTab agentName="Pipeline Bot" artifacts={[]} />,
    );
    expect(
      getByText(/The out-tray stays empty until the first run/),
    ).toBeTruthy();
  });
});
