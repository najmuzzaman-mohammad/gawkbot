import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The subset of PostHog init config the suite inspects.
interface InitCfg {
  loaded?: (ph: unknown) => void;
  api_host?: string;
  autocapture?: boolean;
  capture_pageview?: boolean;
  persistence?: string;
  disable_session_recording?: boolean;
  session_recording?: { maskAllInputs?: boolean; maskTextSelector?: string };
  sanitize_properties?: (p: Record<string, unknown>) => Record<string, unknown>;
  before_send?: (e: unknown) => unknown;
}

// Mock posthog-js. init() invokes the `loaded` callback synchronously so the
// recording-on-load path runs, mirroring the real SDK.
const mockPosthog = {
  init: vi.fn((_key: string, cfg?: InitCfg) => {
    cfg?.loaded?.(mockPosthog);
  }),
  capture: vi.fn(),
  startSessionRecording: vi.fn(),
  stopSessionRecording: vi.fn(),
  opt_in_capturing: vi.fn(),
  opt_out_capturing: vi.fn(),
  setPersonProperties: vi.fn(),
  group: vi.fn(),
};

vi.mock("posthog-js", () => ({ default: mockPosthog }));

import {
  __resetAnalyticsForTests,
  configureAnalytics,
  filterExceptionNoise,
  isValidEmail,
  recordOnboardingEmailCaptured,
  recordOnboardingEmailStarted,
  recordOnboardingEmailViewed,
  setAnalyticsConsent,
  track,
} from "./analytics";

/** Let the dynamic-import + .then chain in the module settle. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetAnalyticsForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isValidEmail", () => {
  it.each([
    ["maya@nex.ai", true],
    ["  sam@dunder.co  ", true],
    ["nope", false],
    ["no@domain", false],
    ["@no-local.com", false],
    ["spaces in@email.com", false],
    ["", false],
  ])("%s -> %s", (input, expected) => {
    expect(isValidEmail(input as string)).toBe(expected);
  });
});

describe("dormant by default", () => {
  it("never loads or inits posthog when no key resolves", async () => {
    track("task_created");
    recordOnboardingEmailViewed();
    recordOnboardingEmailCaptured("maya@nex.ai");
    await flush();
    expect(mockPosthog.init).not.toHaveBeenCalled();
    expect(mockPosthog.capture).not.toHaveBeenCalled();
  });
});

describe("build-time key fallback", () => {
  it("inits from VITE_PUBLIC_POSTHOG_KEY when no runtime config is set", async () => {
    vi.stubEnv("VITE_PUBLIC_POSTHOG_KEY", "phc_build");
    track("task_created", { source: "home" });
    await vi.waitFor(() => expect(mockPosthog.init).toHaveBeenCalledTimes(1));
    expect(mockPosthog.init.mock.calls[0][0]).toBe("phc_build");
    await vi.waitFor(() =>
      expect(mockPosthog.capture).toHaveBeenCalledWith("task_created", {
        source: "home",
      }),
    );
  });
});

describe("configured via runtime injection", () => {
  it("runtime key wins; cookies disabled, autocapture off, recording opt-in", async () => {
    configureAnalytics({
      configured: true,
      posthog_key: "phc_runtime",
      posthog_host: "https://eu.i.posthog.com/",
      telemetry_enabled: true,
      session_recording_enabled: false,
    });
    await vi.waitFor(() => expect(mockPosthog.init).toHaveBeenCalledTimes(1));
    const [key, cfg] = mockPosthog.init.mock.calls[0];
    expect(key).toBe("phc_runtime");
    expect(cfg?.api_host).toBe("https://eu.i.posthog.com");
    expect(cfg?.autocapture).toBe(false);
    expect(cfg?.capture_pageview).toBe(false);
    expect(cfg?.persistence).toBe("localStorage");
    expect(cfg?.disable_session_recording).toBe(true);
    // Recording channel off => not started on load.
    expect(mockPosthog.startSessionRecording).not.toHaveBeenCalled();
  });

  it("starts recording on load masking typed text (inputs) when recording is on", async () => {
    configureAnalytics({
      configured: true,
      posthog_key: "phc_runtime",
      telemetry_enabled: true,
      session_recording_enabled: true,
    });
    await vi.waitFor(() => expect(mockPosthog.init).toHaveBeenCalled());
    const [, cfg] = mockPosthog.init.mock.calls[0];
    // PostHog default: typed text (inputs) is masked, on-screen text is not.
    expect(cfg?.session_recording?.maskAllInputs).toBe(true);
    expect(cfg?.session_recording?.maskTextSelector).toBeUndefined();
    await vi.waitFor(() =>
      expect(mockPosthog.startSessionRecording).toHaveBeenCalledTimes(1),
    );
  });

  it("stays dormant when telemetry is off even with a key", async () => {
    configureAnalytics({
      configured: true,
      posthog_key: "phc_runtime",
      telemetry_enabled: false,
      session_recording_enabled: true,
    });
    track("task_created");
    await flush();
    expect(mockPosthog.init).not.toHaveBeenCalled();
  });
});

describe("onboarding email (the single PII egress)", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_PUBLIC_POSTHOG_KEY", "phc_test");
  });

  it("funnel events carry source only, never an address", async () => {
    recordOnboardingEmailViewed();
    recordOnboardingEmailStarted();
    await vi.waitFor(() =>
      expect(mockPosthog.capture).toHaveBeenCalledWith(
        "onboarding_email_viewed",
        { source: "onboarding-welcome" },
      ),
    );
    expect(mockPosthog.capture).toHaveBeenCalledWith(
      "onboarding_email_started",
      { source: "onboarding-welcome" },
    );
    expect(JSON.stringify(mockPosthog.capture.mock.calls)).not.toContain("@");
    expect(mockPosthog.setPersonProperties).not.toHaveBeenCalled();
  });

  it("captured attaches the email via setPersonProperties, not the event", async () => {
    recordOnboardingEmailCaptured("  maya@nex.ai  ");
    await vi.waitFor(() =>
      expect(mockPosthog.setPersonProperties).toHaveBeenCalledWith({
        email: "maya@nex.ai",
      }),
    );
    expect(mockPosthog.capture).toHaveBeenCalledWith(
      "onboarding_email_captured",
      { source: "onboarding-welcome" },
    );
    const captureCall = mockPosthog.capture.mock.calls.find(
      (c) => c[0] === "onboarding_email_captured",
    );
    expect(JSON.stringify(captureCall?.[1])).not.toContain("@");
  });

  it("ignores a blank email", async () => {
    recordOnboardingEmailCaptured("   ");
    await flush();
    expect(mockPosthog.setPersonProperties).not.toHaveBeenCalled();
    expect(mockPosthog.capture).not.toHaveBeenCalled();
  });

  it.each([
    "seed-user-15",
    "not-an-email",
    "no@domain",
    "@nope.com",
  ])("ignores a non-email value (%s) — never attaches it or emits the event", async (junk) => {
    recordOnboardingEmailCaptured(junk);
    await flush();
    expect(mockPosthog.setPersonProperties).not.toHaveBeenCalled();
    expect(mockPosthog.capture).not.toHaveBeenCalled();
  });
});

describe("live consent changes", () => {
  it("turning recording on starts it; turning telemetry off opts out + stops", async () => {
    configureAnalytics({
      configured: true,
      posthog_key: "phc_runtime",
      telemetry_enabled: true,
      session_recording_enabled: false,
    });
    await vi.waitFor(() => expect(mockPosthog.init).toHaveBeenCalled());
    expect(mockPosthog.startSessionRecording).not.toHaveBeenCalled();

    setAnalyticsConsent({ recording: true });
    await vi.waitFor(() =>
      expect(mockPosthog.startSessionRecording).toHaveBeenCalled(),
    );

    setAnalyticsConsent({ telemetry: false });
    await vi.waitFor(() =>
      expect(mockPosthog.opt_out_capturing).toHaveBeenCalled(),
    );
    expect(mockPosthog.stopSessionRecording).toHaveBeenCalled();
  });
});

describe("sanitize_properties", () => {
  it("enriches events with the active theme from the DOM", async () => {
    document.documentElement.setAttribute("data-theme", "noir-gold");
    configureAnalytics({
      configured: true,
      posthog_key: "phc_runtime",
      telemetry_enabled: true,
      session_recording_enabled: false,
    });
    await vi.waitFor(() => expect(mockPosthog.init).toHaveBeenCalled());
    const [, cfg] = mockPosthog.init.mock.calls[0];
    const enriched = cfg?.sanitize_properties?.({ a: 1 }) ?? {};
    expect(enriched.theme).toBe("noir-gold");
    expect(enriched.app_name).toBe("wuphf-web");
    document.documentElement.removeAttribute("data-theme");
  });

  it("keeps the authoritative app name when callers supply a different value", async () => {
    configureAnalytics({
      configured: true,
      posthog_key: "phc_runtime",
      telemetry_enabled: true,
      session_recording_enabled: false,
    });
    await vi.waitFor(() => expect(mockPosthog.init).toHaveBeenCalled());
    const [, cfg] = mockPosthog.init.mock.calls[0];
    const enriched =
      cfg?.sanitize_properties?.({ app_name: "another-app" }) ?? {};
    expect(enriched.app_name).toBe("wuphf-web");
  });

  it("stamps autocaptured exception properties through the init hook", async () => {
    configureAnalytics({
      configured: true,
      posthog_key: "phc_runtime",
      telemetry_enabled: true,
      session_recording_enabled: false,
    });
    await vi.waitFor(() => expect(mockPosthog.init).toHaveBeenCalled());
    const [, cfg] = mockPosthog.init.mock.calls[0];
    const enriched =
      cfg?.sanitize_properties?.({
        $exception_list: [
          {
            type: "Error",
            value: "No Listener: tabs:outgoing.message.ready",
          },
        ],
        $exception_level: "error",
      }) ?? {};
    expect(enriched.app_name).toBe("wuphf-web");
  });
});

describe("filterExceptionNoise", () => {
  // filterExceptionNoise is typed against posthog's CaptureResult; tests build
  // minimal shapes, so route them through a small casting helper.
  type Item = {
    mechanism?: { handled?: boolean; synthetic?: boolean };
    stacktrace?: { frames?: unknown[] };
  };
  const run = (event: unknown): unknown =>
    filterExceptionNoise(event as Parameters<typeof filterExceptionNoise>[0]);
  const exception = (...list: Item[]): unknown => ({
    event: "$exception",
    properties: { $exception_list: list },
  });

  it("passes non-exception events through untouched", () => {
    const evt = { event: "$pageview", properties: { $current_url: "/x" } };
    expect(run(evt)).toBe(evt);
  });

  it("passes through when the exception list is missing or empty", () => {
    const missing = { event: "$exception", properties: {} };
    expect(run(missing)).toBe(missing);
    const empty = exception();
    expect(run(empty)).toBe(empty);
  });

  it("drops the reported injected-bus rejection (unhandled, synthetic, no frames)", () => {
    // 'Error' captured as exception with message:
    // 'No Listener: tabs:outgoing.message.ready' — a browser-extension bus
    // rejection captured on our page. See PR description.
    const evt = exception({ mechanism: { handled: false, synthetic: true } });
    expect(run(evt)).toBeNull();
  });

  it("drops exceptions whose frames are all from a browser extension", () => {
    const evt = exception({
      mechanism: { handled: false, synthetic: false },
      stacktrace: {
        frames: [
          { abs_path: "chrome-extension://abc/content.js", in_app: false },
          { filename: "moz-extension://def/inject.js", in_app: false },
        ],
      },
    });
    expect(run(evt)).toBeNull();
  });

  it("keeps exceptions with at least one in-app frame", () => {
    const evt = exception({
      mechanism: { handled: false, synthetic: true },
      stacktrace: {
        frames: [
          { abs_path: "chrome-extension://abc/content.js", in_app: false },
          { filename: "http://127.0.0.1:7891/assets/app.js", in_app: true },
        ],
      },
    });
    expect(run(evt)).toBe(evt);
  });

  it("keeps frameful exceptions we cannot attribute to an extension", () => {
    // No in-app flag but same-origin bundle frames (e.g. un-source-mapped) —
    // we do not guess these away.
    const evt = exception({
      mechanism: { handled: false, synthetic: false },
      stacktrace: {
        frames: [{ filename: "http://127.0.0.1:7891/assets/app.js" }],
      },
    });
    expect(run(evt)).toBe(evt);
  });

  it("keeps frameless exceptions that are handled or non-synthetic", () => {
    expect(
      run(exception({ mechanism: { handled: true, synthetic: true } })),
    ).not.toBeNull();
    expect(
      run(exception({ mechanism: { handled: false, synthetic: false } })),
    ).not.toBeNull();
  });

  it("keeps the event when any exception in the list is ours", () => {
    const evt = exception(
      { mechanism: { handled: false, synthetic: true } },
      {
        mechanism: { handled: false, synthetic: false },
        stacktrace: { frames: [{ filename: "app.js", in_app: true }] },
      },
    );
    expect(run(evt)).toBe(evt);
  });

  it("is wired into posthog init as before_send", async () => {
    configureAnalytics({
      configured: true,
      posthog_key: "phc_runtime",
      telemetry_enabled: true,
      session_recording_enabled: false,
    });
    await vi.waitFor(() => expect(mockPosthog.init).toHaveBeenCalled());
    const cfg = mockPosthog.init.mock.calls[0][1];
    const dropped = cfg?.before_send?.(
      exception({ mechanism: { handled: false, synthetic: true } }),
    );
    expect(dropped).toBeNull();
  });
});
