/**
 * BotFileBlockEditor — structured, per-section editing of a bot instruction
 * file. Each `## ` section is its own labelled block with a hint; expected
 * sections that are missing show as empty blocks to fill, and any extra sections
 * the file carries are preserved. This keeps a file's structure intact even when
 * someone edits it heavily — the failure mode of the free-form raw editor.
 *
 * Raw editing is still available as the "Advanced" escape hatch in
 * BotInstructionsSection; this is the default.
 */

import { useMemo, useRef, useState } from "react";

import type { BotFileResponse } from "../../api/botFiles";
import { writeBotFile } from "../../api/botFiles";
import {
  buildEditorBlocks,
  parseBotFile,
  schemaForFile,
  serializeBotFile,
} from "../../lib/botFileSections";

interface BotFileBlockEditorProps {
  path: string;
  /** File label (SOUL / IDENTITY / OPERATIONS / TOOLS / USER) — picks schema. */
  label: string;
  data: BotFileResponse;
  onSaved: (newSha: string) => void;
  onCancel: () => void;
}

interface BlockState {
  heading: string;
  body: string;
  hint?: string;
  fromSchema: boolean;
}

export function BotFileBlockEditor({
  path,
  label,
  data,
  onSaved,
  onCancel,
}: BotFileBlockEditorProps) {
  const parsed = useMemo(() => parseBotFile(data.content), [data.content]);
  const initialBlocks = useMemo<BlockState[]>(
    () => buildEditorBlocks(parsed, schemaForFile(label)),
    [parsed, label],
  );
  // The preamble (content above the first section) is editable too. Show it
  // when the file has one, or when there are no section blocks at all (flat
  // files like IDENTITY/USER edit entirely through this block).
  const showPreamble =
    parsed.preamble.trim() !== "" || initialBlocks.length === 0;

  const [preamble, setPreamble] = useState(parsed.preamble);
  const [blocks, setBlocks] = useState<BlockState[]>(initialBlocks);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Snapshot the SHA at edit-open. Using the live `data.sha` at save time
  // would let a background refetch advance it mid-edit, so a save could
  // silently overwrite newer disk content instead of getting a conflict.
  const expectedShaRef = useRef(data.sha);

  const dirty =
    preamble !== parsed.preamble ||
    blocks.some((b, i) => b.body !== (initialBlocks[i]?.body ?? ""));

  function setBlockBody(index: number, body: string) {
    setBlocks((prev) => prev.map((b, i) => (i === index ? { ...b, body } : b)));
  }

  async function save() {
    setSaving(true);
    setError(null);
    // Keep schema-section headings even when emptied so the file's structure
    // is preserved (the section reappears as an empty-to-fill block on reopen).
    // Only drop emptied *custom* sections — clearing one is an intentional
    // delete, not a structural section.
    const sections = blocks
      .filter((b) => b.fromSchema || b.body.trim() !== "")
      .map((b) => ({ heading: b.heading, body: b.body.trim() }));
    const content = serializeBotFile({
      title: parsed.title,
      preamble: preamble.trim(),
      sections,
    });
    try {
      const result = await writeBotFile({
        path,
        content,
        commitMessage: `Update ${label}`,
        expectedSha: expectedShaRef.current,
      });
      if ("commit_sha" in result) {
        onSaved(result.commit_sha);
      } else {
        setError("This file changed on disk. Close and re-open to reload.");
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bot-file-blocks">
      {showPreamble ? (
        <label className="bot-file-block">
          <span className="bot-file-block-label">Overview</span>
          <textarea
            className="bot-file-block-input"
            value={preamble}
            onChange={(e) => setPreamble(e.target.value)}
            disabled={saving}
            rows={3}
            placeholder="A short opening line for this file…"
          />
        </label>
      ) : null}

      {blocks.map((block, index) => (
        <label className="bot-file-block" key={block.heading}>
          <span className="bot-file-block-label">
            {block.heading}
            {block.fromSchema ? null : (
              <span className="bot-file-block-tag">custom</span>
            )}
          </span>
          {block.hint ? (
            <span className="bot-file-block-hint">{block.hint}</span>
          ) : null}
          <textarea
            className="bot-file-block-input"
            value={block.body}
            onChange={(e) => setBlockBody(index, e.target.value)}
            disabled={saving}
            rows={4}
            placeholder={
              block.fromSchema ? `Add ${block.heading.toLowerCase()}…` : ""
            }
            aria-label={`${label} — ${block.heading}`}
          />
        </label>
      ))}

      {error ? (
        <div className="bot-file-card-error" role="alert">
          {error}
        </div>
      ) : null}

      <div className="bot-file-card-actions">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => void save()}
          disabled={saving || !dirty}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
