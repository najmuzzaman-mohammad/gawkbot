// Artifacts — the file-ish outcomes a BOT's runs produce: PDFs, HTML pages,
// markdown docs. The bot's ONE built app is not an artifact — it IS the UI
// tab; artifacts collect below it as the outputs of routines and tool runs.
//
// FE-first: the shapes are real, the seeds are mock (used by the mock bot
// detail to show the range; a real bot starts empty and collects artifacts as
// tools/runs produce them).

export type ArtifactType = "pdf" | "html" | "md";

export interface Artifact {
  id: string;
  type: ArtifactType;
  /** Filename-ish display title, e.g. "weekly-pipeline-summary.md". */
  title: string;
  /** What produced it, e.g. "weeklyPipelineSummary" or "built by a bot". */
  producedBy: string;
  at: string;
  /** Inline content for md/html; absent for pdf (file-ish, download only). */
  content?: string;
  /** Download URL for file-ish artifacts; absent until the file is exported. */
  url?: string;
  /** Display size for file-ish artifacts. */
  size?: string;
}

/** Short uppercase badge per artifact type. */
export const ARTIFACT_BADGE: Record<ArtifactType, string> = {
  pdf: "PDF",
  html: "HTML",
  md: "MD",
};

const SUMMARY_MD = `# Weekly pipeline summary

**Week of Jun 29 — Jul 5**

- 6 deals moved · $420k created · 2 slipped
- Biggest move: **Globex → Negotiation** ($120k)
- Stalled: Initech (9 days no touch) — follow-up drafted
- New: Acme (Proposal, $80k) — routed to Priya (AE)

_Produced by weeklyPipelineSummary — runs every Monday._`;

const SCORES_HTML = `<!doctype html><html><head><style>
body{font-family:-apple-system,system-ui,sans-serif;margin:24px;color:#1a1a1a}
table{border-collapse:collapse;width:100%}td,th{padding:8px 12px;border-bottom:1px solid #e5e5e5;text-align:left}
th{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#777}
.hot{color:#0a7d33;font-weight:600}</style></head><body>
<h2>Lead scores — this week</h2>
<table><tr><th>Lead</th><th>Fit</th><th>Routed to</th></tr>
<tr><td>Acme</td><td class="hot">82</td><td>Priya (AE)</td></tr>
<tr><td>Globex</td><td class="hot">88</td><td>Priya (AE)</td></tr>
<tr><td>Initech</td><td>61</td><td>queue</td></tr></table>
</body></html>`;

/** Mock non-app artifacts for the showcase (the mock bot detail). */
export function seedArtifacts(): Artifact[] {
  return [
    {
      id: "art_md_1",
      type: "md",
      title: "weekly-pipeline-summary.md",
      producedBy: "weeklyPipelineSummary",
      at: "Monday 9:02",
      content: SUMMARY_MD,
    },
    {
      id: "art_html_1",
      type: "html",
      title: "lead-scores.html",
      producedBy: "scoreAndRouteLead",
      at: "yesterday",
      content: SCORES_HTML,
    },
    {
      id: "art_pdf_1",
      type: "pdf",
      title: "q3-pipeline-brief.pdf",
      producedBy: "weeklyPipelineSummary",
      at: "Jun 30",
      size: "182 KB",
    },
  ];
}
