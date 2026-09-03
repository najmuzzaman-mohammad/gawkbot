/**
 * OnboardingWizard — the wizard must complete end to end with starter packs
 * hidden.
 *
 * Onboarding is deliberately minimal right now: pick a runtime, name the
 * office, land in #general with the CEO. The "Pick a team pack" step is gated
 * off behind ONBOARDING_TEAM_PACKS_ENABLED (wizardSteps.ts). These tests pin
 * the failure modes that gating a step usually introduces:
 *
 *   - a dead step: the team screen still reachable, or a Next that goes
 *     nowhere,
 *   - a stale counter: a "01 / 06" marker or six dots over five steps,
 *   - a broken seed: a finish that no longer sends the scratch-path payload
 *     (blueprint "", bots []) the broker turns into a CEO plus #general.
 *
 * Only the network boundary is mocked. Every step screen renders for real, so
 * a starter-pack card leaking back into the flow fails the first test.
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  BlueprintSummary,
  CompleteOnboardingBody,
  CompleteOnboardingResult,
} from "../../../api/onboarding";
import { OnboardingWizard } from "./OnboardingWizard";
import {
  ONBOARDING_TEAM_PACKS_ENABLED,
  ONBOARDING_WIZARD_STEP_IDS,
} from "./wizardSteps";

const completeOnboarding = vi.fn(
  async (_body: CompleteOnboardingBody): Promise<CompleteOnboardingResult> => ({
    ok: true,
  }),
);
const fetchBlueprints = vi.fn(async (): Promise<BlueprintSummary[]> => []);
const postOnboardingAnswer = vi.fn(
  async (_key: string, _value: string): Promise<void> => undefined,
);
const postOnboardingProgress = vi.fn(
  async (_step: string, _values: Record<string, string>): Promise<void> =>
    undefined,
);

vi.mock("../../../api/onboarding", () => ({
  completeOnboarding: (body: CompleteOnboardingBody) =>
    completeOnboarding(body),
  fetchBlueprints: () => fetchBlueprints(),
  postOnboardingAnswer: (key: string, value: string) =>
    postOnboardingAnswer(key, value),
  postOnboardingProgress: (step: string, values: Record<string, string>) =>
    postOnboardingProgress(step, values),
}));

// The wiki step offers an embedder; keep it off the network and on its
// documented keyword default so the step renders its real markup.
vi.mock("../../../api/knowledge", async (importActual) => {
  const actual = await importActual<typeof import("../../../api/knowledge")>();
  return {
    ...actual,
    fetchEmbeddingOptions: async () => actual.EMBEDDING_OPTIONS_FALLBACK,
    installGbrain: async () => actual.EMBEDDING_OPTIONS_FALLBACK,
  };
});

// Analytics is dormant without a PostHog key, but stub the emitters anyway so
// the assertions below never depend on env-dependent side effects.
vi.mock("../../../lib/analytics", async (importActual) => {
  const actual = await importActual<typeof import("../../../lib/analytics")>();
  return {
    ...actual,
    track: vi.fn(),
    setAnalyticsConsent: vi.fn(),
    recordOnboardingEmailViewed: vi.fn(),
    recordOnboardingEmailStarted: vi.fn(),
    recordOnboardingEmailCaptured: vi.fn(),
  };
});

/** Advance the wizard with the footer's primary button. */
function clickNext(): void {
  fireEvent.click(screen.getByTestId("onboarding-wizard-primary"));
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("OnboardingWizard with starter packs hidden", () => {
  it("drops the team step from the run order and never fetches blueprints", () => {
    expect(ONBOARDING_TEAM_PACKS_ENABLED).toBe(false);
    expect(ONBOARDING_WIZARD_STEP_IDS).toEqual([
      "meet",
      "wiki",
      "ship",
      "computer",
      "first-issue",
    ]);

    render(<OnboardingWizard onComplete={vi.fn()} />);
    expect(fetchBlueprints).not.toHaveBeenCalled();
  });

  it("walks every step to the finish CTA without a pack picker or a dead step", () => {
    render(<OnboardingWizard onComplete={vi.fn()} />);

    expect(screen.getByTestId("onboarding-step-meet")).toBeTruthy();
    clickNext();
    expect(screen.getByTestId("onboarding-step-wiki")).toBeTruthy();
    clickNext();
    // The team step used to sit here. Its successor must render instead.
    expect(screen.queryByTestId("onboarding-step-team")).toBeNull();
    expect(screen.getByTestId("onboarding-step-ship")).toBeTruthy();
    clickNext();
    expect(screen.getByTestId("onboarding-step-computer")).toBeTruthy();
    clickNext();
    expect(screen.getByTestId("onboarding-step-first-issue")).toBeTruthy();

    // The last step's primary button is Finish, not another Next.
    expect(
      screen.getByTestId("onboarding-wizard-primary").textContent,
    ).toContain("Write your first issue");
  });

  it("shows no pack cards, no roster, and no team-skip escape anywhere", () => {
    render(<OnboardingWizard onComplete={vi.fn()} />);

    for (let step = 0; step < ONBOARDING_WIZARD_STEP_IDS.length; step += 1) {
      expect(screen.queryByTestId("onboarding-blueprints")).toBeNull();
      expect(screen.queryByTestId("onboarding-blueprint-scratch")).toBeNull();
      expect(screen.queryByTestId("onboarding-roster")).toBeNull();
      expect(screen.queryByTestId("onboarding-wizard-team-skip")).toBeNull();
      if (step < ONBOARDING_WIZARD_STEP_IDS.length - 1) clickNext();
    }
  });

  it("counts the steps it actually runs in the marker and the dots", () => {
    const { container } = render(<OnboardingWizard onComplete={vi.fn()} />);

    const marker = container.querySelector(".onboarding-wizard-step-marker");
    expect(marker?.textContent).toBe("01 / 05");
    expect(screen.getByLabelText("Step 1 of 5")).toBeTruthy();
    expect(container.querySelectorAll(".onboarding-wizard-dot")).toHaveLength(
      5,
    );
    expect(screen.queryByTestId("onboarding-wizard-dot-team")).toBeNull();

    clickNext();
    expect(
      container.querySelector(".onboarding-wizard-step-marker")?.textContent,
    ).toBe("02 / 05");
  });

  it("finishes on the broker's scratch path, which seeds a CEO and #general", async () => {
    const onComplete = vi.fn();
    render(<OnboardingWizard onComplete={onComplete} />);

    fireEvent.change(screen.getByTestId("onboarding-office-name"), {
      target: { value: "Dunder HQ" },
    });
    clickNext();
    clickNext();
    clickNext();
    clickNext();

    await act(async () => {
      fireEvent.click(screen.getByTestId("onboarding-wizard-primary"));
    });

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));

    // An empty blueprint with an explicitly empty bots list is the broker's
    // lead-only seed. Sending `undefined`/omitting bots would take the
    // legacy synthesis path and seed a five-bot roster instead.
    expect(completeOnboarding).toHaveBeenCalledTimes(1);
    expect(completeOnboarding).toHaveBeenCalledWith(
      expect.objectContaining({
        blueprint: "",
        agents: [],
        skip_task: false,
      }),
    );
    expect(postOnboardingProgress).toHaveBeenCalledWith("identity", {
      company_name: "Dunder HQ",
    });
  });
});
