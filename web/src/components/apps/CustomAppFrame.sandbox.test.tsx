import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CustomAppFrame } from "./CustomAppFrame";

vi.mock("../../api/client", () => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("../ui/ConfirmDialog", () => ({ confirm: vi.fn() }));
vi.mock("../ui/Toast", () => ({ showNotice: vi.fn() }));

// The sandbox list is a security boundary AND a functional contract: without
// allow-forms Chrome never dispatches submit events inside the frame, so any
// generated app built on a native <form> dead-ends silently (no handler runs,
// no error anywhere). Navigation-on-submit stays blocked by form-action
// 'none' in APP_CSP, so granting allow-forms does not widen exfiltration.
describe("CustomAppFrame sandbox", () => {
  it("published apps run with scripts + form events but never same-origin", () => {
    const { container } = render(
      <CustomAppFrame html="<html><body>app</body></html>" title="t" />,
    );
    const frame = container.querySelector("iframe");
    const sandbox = frame?.getAttribute("sandbox") ?? "";
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).toContain("allow-forms");
    expect(sandbox).not.toContain("allow-same-origin");
  });

  it("dev preview keeps same-origin (localhost dev server) plus form events", () => {
    const { container } = render(
      <CustomAppFrame devUrl="http://localhost:5599/" title="t" />,
    );
    const sandbox =
      container.querySelector("iframe")?.getAttribute("sandbox") ?? "";
    expect(sandbox).toContain("allow-same-origin");
    expect(sandbox).toContain("allow-forms");
  });
});
