// ArtifactsTab — the file-ish outcomes the bot produced (PDFs, HTML pages,
// markdown docs) as a chip strip with a viewer per type below. It lives INSIDE
// the UI tab, under the bot's one live app — the app itself is the tab, not
// an artifact. See web/src/operator/artifacts/artifacts.ts.

import { useState } from "react";
import { Download, FileText } from "lucide-react";

import { formatStamp } from "../routines/routines";
import { ARTIFACT_BADGE, type Artifact } from "./artifacts";

interface ArtifactsTabProps {
  agentName: string;
  artifacts: Artifact[];
}

export function ArtifactsTab({ agentName, artifacts }: ArtifactsTabProps) {
  const [selectedId, setSelectedId] = useState<string | null>(
    artifacts[0]?.id ?? null,
  );
  const selected = artifacts.find((a) => a.id === selectedId) ?? artifacts[0];

  if (artifacts.length === 0) {
    return (
      <div className="opr-empty-hint">
        Everything {agentName} produces collects here — apps, PDFs, pages, docs.
        The out-tray stays empty until the first run.
      </div>
    );
  }

  return (
    <div className="opr-artifacts">
      {/* Honest semantics: a group of toggle buttons, not a tablist (no
          aria-controls/tabpanel/arrow-key contract here). */}
      <div
        className="opr-artifact-strip"
        role="group"
        aria-label="Artifacts this app produced"
      >
        {artifacts.map((a) => (
          <button
            key={a.id}
            type="button"
            aria-pressed={selected?.id === a.id}
            className={`opr-artifact-chip${selected?.id === a.id ? " is-active" : ""}`}
            onClick={() => setSelectedId(a.id)}
          >
            <span className={`opr-artifact-badge is-${a.type}`}>
              {ARTIFACT_BADGE[a.type]}
            </span>
            <span className="opr-artifact-chip-body">
              <span className="opr-artifact-title">{a.title}</span>
              <span className="opr-artifact-meta">
                {a.producedBy} · {formatStamp(a.at)}
              </span>
            </span>
          </button>
        ))}
      </div>

      {selected ? (
        <div className="opr-artifact-viewer">
          <ArtifactViewer artifact={selected} />
        </div>
      ) : null}
    </div>
  );
}

function ArtifactViewer({ artifact }: { artifact: Artifact }) {
  switch (artifact.type) {
    case "md":
      return (
        <pre className="opr-artifact-md">
          <code>{artifact.content ?? ""}</code>
        </pre>
      );
    case "html":
      // Fully sandboxed: produced HTML renders inert (no scripts, no navigation).
      return (
        <iframe
          className="opr-artifact-html"
          title={artifact.title}
          sandbox=""
          srcDoc={artifact.content ?? ""}
        />
      );
    case "pdf":
      return (
        <div className="opr-artifact-file">
          <span className="opr-artifact-file-glyph" aria-hidden={true}>
            <FileText size={22} strokeWidth={1.6} />
          </span>
          <div className="opr-artifact-file-body">
            <div className="opr-artifact-title">{artifact.title}</div>
            <div className="opr-artifact-meta">
              {artifact.size ?? "PDF"} · {artifact.producedBy} ·{" "}
              {formatStamp(artifact.at)}
            </div>
          </div>
          {artifact.url ? (
            <a
              className="opr-btn opr-btn-sm"
              href={artifact.url}
              download={artifact.title}
            >
              <Download size={13} strokeWidth={1.9} aria-hidden={true} />
              Download
            </a>
          ) : (
            <button
              type="button"
              className="opr-btn opr-btn-sm"
              disabled={true}
              title="Not exported yet"
            >
              <Download size={13} strokeWidth={1.9} aria-hidden={true} />
              Download
            </button>
          )}
        </div>
      );
    default:
      return null;
  }
}
