import {
  Component,
  type ErrorInfo,
  type ReactNode,
  useMemo,
  useState,
} from "react";
import {
  createParser,
  type OpenUIError,
  type ParseResult,
  Renderer,
} from "@openuidev/react-lang";

import type {
  OpenUIRichArtifactDetail,
  RichArtifactDetail,
} from "../../api/richArtifacts";
import { openUIArtifactLibrary } from "../../lib/openUIArtifactLibrary";
import RichArtifactEmbed from "./RichArtifactEmbed";

const MAX_STATEMENTS = 256;
const MAX_SOURCE_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 4096;
const MAX_NODES = 320;
const MAX_DEPTH = 14;
const MAX_ARRAY_ITEMS = 1200;
const MAX_STRING_CHARS = 80_000;

interface RichArtifactRendererProps {
  detail: RichArtifactDetail;
  surface?: string;
}

export default function RichArtifactRenderer({
  detail,
  surface = "unknown",
}: RichArtifactRendererProps) {
  const { artifact } = detail;
  return (
    <ArtifactErrorBoundary
      key={`${artifact.id}:${artifact.contentHash}`}
      artifactId={artifact.id}
      contentHash={artifact.contentHash}
      representation={artifact.representation}
      surface={surface}
    >
      {isOpenUIDetail(detail) ? (
        <OpenUIArtifactRenderer detail={detail} surface={surface} />
      ) : (
        <RichArtifactEmbed title={artifact.title} html={detail.html} />
      )}
    </ArtifactErrorBoundary>
  );
}

function isOpenUIDetail(
  detail: RichArtifactDetail,
): detail is OpenUIRichArtifactDetail {
  return detail.artifact.representation === "openui";
}

function OpenUIArtifactRenderer({
  detail,
  surface,
}: {
  detail: Extract<RichArtifactDetail, { openui: string }>;
  surface: string;
}) {
  const [runtimeErrors, setRuntimeErrors] = useState<OpenUIError[]>([]);
  const validation = useMemo(
    () => validateOpenUIArtifact(detail.openui),
    [detail.openui],
  );

  if (!validation.ok) {
    reportArtifactFailure(detail, surface, validation.code, validation.errors);
    return (
      <ArtifactFailureCard
        title={detail.artifact.title}
        code={validation.code}
      />
    );
  }
  if (runtimeErrors.length > 0) {
    return (
      <ArtifactFailureCard
        title={detail.artifact.title}
        code="openui_runtime_error"
      />
    );
  }
  return (
    <div
      className="openui-artifact-renderer"
      data-testid="openui-artifact-renderer"
    >
      <Renderer
        library={openUIArtifactLibrary}
        response={detail.openui}
        isStreaming={false}
        toolProvider={null}
        onError={(errors) => {
          if (errors.length > 0) {
            setRuntimeErrors(errors);
            reportArtifactFailure(
              detail,
              surface,
              "openui_runtime_error",
              errors.map((error) => error.code),
            );
          }
        }}
      />
    </div>
  );
}

type ValidationResult =
  | { ok: true; result: ParseResult }
  | { ok: false; code: string; errors: string[] };

export function validateOpenUIArtifact(source: string): ValidationResult {
  if (new TextEncoder().encode(source).length > MAX_SOURCE_BYTES) {
    return { ok: false, code: "openui_source_budget", errors: [] };
  }
  if (
    source
      .split("\n")
      .some((line) => new TextEncoder().encode(line).length > MAX_LINE_BYTES)
  ) {
    return { ok: false, code: "openui_line_budget", errors: [] };
  }
  const activeSyntax = source.replace(/"(?:\\.|[^"\\])*"/gs, '""');
  if (
    /\b(?:Query|Mutation)\s*\(/i.test(activeSyntax) ||
    /@(?:OpenUrl|ToAssistant|Run|Set|Reset)\s*\(/i.test(activeSyntax) ||
    /^\s*\$[A-Za-z_][A-Za-z0-9_]*\s*=/m.test(activeSyntax)
  ) {
    return { ok: false, code: "openui_active_syntax", errors: [] };
  }
  let result: ParseResult;
  try {
    result = createParser(openUIArtifactLibrary.toJSONSchema()).parse(source);
  } catch (error: unknown) {
    return {
      ok: false,
      code: "openui_parse_exception",
      errors: [error instanceof Error ? error.name : "unknown"],
    };
  }
  if (!result.root) {
    return { ok: false, code: "openui_missing_root", errors: [] };
  }
  if (result.meta.incomplete) {
    return { ok: false, code: "openui_incomplete", errors: [] };
  }
  if (result.meta.errors.length > 0 || result.meta.unresolved.length > 0) {
    return {
      ok: false,
      code: "openui_parse_error",
      errors: [
        ...result.meta.errors.map((error) => error.code),
        ...result.meta.unresolved.map(() => "unresolved_reference"),
      ],
    };
  }
  if (
    Object.keys(result.stateDeclarations).length > 0 ||
    result.queryStatements.length > 0 ||
    result.mutationStatements.length > 0 ||
    result.meta.orphaned.length > 0
  ) {
    return { ok: false, code: "openui_active_syntax", errors: [] };
  }
  if (result.meta.statementCount > MAX_STATEMENTS) {
    return { ok: false, code: "openui_statement_budget", errors: [] };
  }
  const budget = inspectRenderBudget(result.root);
  if (!budget.ok) return budget;
  return { ok: true, result };
}

type BudgetResult =
  | { ok: true }
  | { ok: false; code: string; errors: string[] };

function inspectRenderBudget(root: unknown): BudgetResult {
  const state: RenderBudgetState = {
    seen: new WeakSet<object>(),
    nodes: 0,
    arrayItems: 0,
    stringChars: 0,
  };
  const failure = visitRenderValue(root, 0, state);
  return failure ? { ok: false, code: failure, errors: [] } : { ok: true };
}

interface RenderBudgetState {
  seen: WeakSet<object>;
  nodes: number;
  arrayItems: number;
  stringChars: number;
}

function visitRenderValue(
  value: unknown,
  depth: number,
  state: RenderBudgetState,
): string | null {
  if (depth > MAX_DEPTH) return "openui_depth_budget";
  if (typeof value === "string") return visitRenderString(value, state);
  if (value === null || typeof value !== "object") return null;
  if (state.seen.has(value)) return "openui_cycle";
  state.seen.add(value);
  return Array.isArray(value)
    ? visitRenderArray(value, depth, state)
    : visitRenderObject(value, depth, state);
}

function visitRenderString(value: string, state: RenderBudgetState) {
  state.stringChars += value.length;
  return state.stringChars > MAX_STRING_CHARS ? "openui_string_budget" : null;
}

function visitRenderArray(
  values: unknown[],
  depth: number,
  state: RenderBudgetState,
) {
  state.arrayItems += values.length;
  if (state.arrayItems > MAX_ARRAY_ITEMS) return "openui_array_budget";
  return visitRenderChildren(values, depth, state);
}

function visitRenderObject(
  value: object,
  depth: number,
  state: RenderBudgetState,
) {
  const record = value as Record<string, unknown>;
  if (record.type === "element") {
    state.nodes++;
    if (state.nodes > MAX_NODES) return "openui_node_budget";
  }
  return visitRenderChildren(Object.values(record), depth, state);
}

function visitRenderChildren(
  values: unknown[],
  depth: number,
  state: RenderBudgetState,
) {
  for (const value of values) {
    const failure = visitRenderValue(value, depth + 1, state);
    if (failure) return failure;
  }
  return null;
}

function ArtifactFailureCard({ title, code }: { title: string; code: string }) {
  return (
    <div className="openui-artifact-error" role="alert">
      <strong>Could not render {title}</strong>
      <span>Artifact error: {code}</span>
    </div>
  );
}

function reportArtifactFailure(
  detail: Extract<RichArtifactDetail, { openui: string }>,
  surface: string,
  code: string,
  errors: string[],
) {
  console.error("OpenUI artifact render failure", {
    artifactId: detail.artifact.id,
    contentHash: detail.artifact.contentHash,
    libraryHash: detail.artifact.openuiLibraryHash,
    surface,
    code,
    errors,
  });
}

interface ArtifactErrorBoundaryProps {
  artifactId: string;
  contentHash: string;
  representation: string;
  surface: string;
  children: ReactNode;
}

class ArtifactErrorBoundary extends Component<
  ArtifactErrorBoundaryProps,
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Rich artifact boundary failure", {
      artifactId: this.props.artifactId,
      contentHash: this.props.contentHash,
      representation: this.props.representation,
      surface: this.props.surface,
      errorName: error.name,
      componentStack: info.componentStack ? "present" : "missing",
    });
  }

  render() {
    if (this.state.failed) {
      return <ArtifactFailureCard title="artifact" code="render_boundary" />;
    }
    return this.props.children;
  }
}
