import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  OPENUI_ARTIFACT_LIBRARY,
  OPENUI_ARTIFACT_LIBRARY_HASH,
  OPENUI_ARTIFACT_VERSION,
  type OpenUIRichArtifactDetail,
} from "../../api/richArtifacts";
import RichArtifactRenderer, {
  validateOpenUIArtifact,
} from "./RichArtifactRenderer";

function detail(openui: string): OpenUIRichArtifactDetail {
  return {
    artifact: {
      id: "ra_0123456789abcdef",
      kind: "notebook_openui",
      title: "Review",
      summary: "",
      trustLevel: "draft",
      representation: "openui",
      contentPath: "wiki/visual-artifacts/ra_0123456789abcdef.openui",
      openuiVersion: OPENUI_ARTIFACT_VERSION,
      openuiLibrary: OPENUI_ARTIFACT_LIBRARY,
      openuiLibraryHash: OPENUI_ARTIFACT_LIBRARY_HASH,
      createdBy: "pm",
      createdAt: "2026-07-10T12:00:00Z",
      updatedAt: "2026-07-10T12:00:00Z",
      contentHash:
        "53ec2f5d8a27617ca1e91b13261bb782b1c02eb6c4049a30528b7fb5f890cd58",
    },
    openui,
  };
}

describe("RichArtifactRenderer", () => {
  it("renders valid OpenUI Lang through the official renderer", async () => {
    render(
      <RichArtifactRenderer
        detail={detail(`root = Stack([heading, body])
heading = Heading("Quarterly review", "1")
body = Text("The plan is on track.", "default")`)}
        surface="test"
      />,
    );

    expect(await screen.findByText("Quarterly review")).toBeInTheDocument();
    expect(screen.getByText("The plan is on track.")).toBeInTheDocument();
  });

  it("fails closed when the parser reports an unknown component", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <RichArtifactRenderer
        detail={detail('root = RemoteImage("https://tracker.example/pixel")')}
        surface="test"
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("openui_missing_root");
    expect(document.querySelector("img")).toBeNull();
  });
});

describe("validateOpenUIArtifact", () => {
  it("rejects active syntax even when calls contain whitespace", () => {
    expect(
      validateOpenUIArtifact(
        'root = Stack([])\nquery = Query ("tool", {}, "fallback", 1)',
      ),
    ).toMatchObject({ ok: false, code: "openui_active_syntax" });
    expect(
      validateOpenUIArtifact('root = Stack([])\n$value = "state"'),
    ).toMatchObject({ ok: false, code: "openui_active_syntax" });
  });

  it("enforces the source budget before parsing", () => {
    expect(
      validateOpenUIArtifact(`root = Stack([])\n#${"x".repeat(64 * 1024)}`),
    ).toMatchObject({ ok: false, code: "openui_source_budget" });
  });

  it("rejects unresolved references", () => {
    const result = validateOpenUIArtifact("root = Stack([missing])");
    expect(result).toMatchObject({ ok: false, code: "openui_parse_error" });
  });

  it("rejects parser-repaired incomplete documents", () => {
    expect(validateOpenUIArtifact("root = Stack([]")).toMatchObject({
      ok: false,
      code: "openui_incomplete",
    });
  });

  it("rejects statement counts over the render budget", () => {
    const children = Array.from({ length: 256 }, (_, index) => `item${index}`);
    const source = [
      `root = Stack([${children.join(", ")}])`,
      ...children.map((name, index) => `${name} = Text("${index}")`),
    ].join("\n");
    expect(validateOpenUIArtifact(source)).toMatchObject({
      ok: false,
      code: "openui_statement_budget",
    });
  });
});
