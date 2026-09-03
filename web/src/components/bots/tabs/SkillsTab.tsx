/**
 * Skills tab — shows skills assigned to this bot and lets the operator
 * add or remove them.
 *
 * Two modes, toggled by the "Enabled / Library" switch:
 *  - Enabled: skills where `owner_agents` includes this bot (card grid).
 *  - Library: all active skills not yet assigned (row list with Add button).
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search } from "iconoir-react";

import type { Skill } from "../../../api/client";
import {
  disableSkillForBot,
  enableSkillForBot,
  getSkillsList,
} from "../../../api/client";
import { PixelSkillCard } from "../../apps/skills/PixelSkillCard";

interface SkillsTabProps {
  agentSlug: string;
}

type Mode = "enabled" | "library";

/** Enabled-mode body: a card grid of the bot's assigned skills. */
function EnabledSkillsGrid({
  skills,
  agentSlug,
  filtered,
  onRemove,
  removePending,
}: {
  skills: Skill[];
  agentSlug: string;
  filtered: boolean;
  onRemove: (name: string) => void;
  removePending: boolean;
}) {
  if (skills.length === 0) {
    return (
      <p className="bot-skills-empty">
        {filtered
          ? "No enabled skills match the filter."
          : `No skills assigned to @${agentSlug} yet. Add from the Library tab.`}
      </p>
    );
  }
  return (
    <ul className="bot-skills-grid">
      {skills.map((sk) => (
        <li key={sk.name} className="bot-skills-card-wrapper">
          <PixelSkillCard
            skill={sk}
            actions={
              <button
                type="button"
                className="bot-skills-card-btn bot-skills-card-btn--remove"
                disabled={removePending}
                onClick={() => onRemove(sk.name)}
                aria-label={`Remove ${sk.title ?? sk.name} from @${agentSlug}`}
              >
                Remove
              </button>
            }
          />
          <span className="bot-skills-card-pill" aria-hidden="true">
            Enabled
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Library-mode body: a row list of unassigned skills with an Add button. */
function LibrarySkillsList({
  skills,
  agentSlug,
  filtered,
  onAdd,
  addPending,
}: {
  skills: Skill[];
  agentSlug: string;
  filtered: boolean;
  onAdd: (name: string) => void;
  addPending: boolean;
}) {
  if (skills.length === 0) {
    return (
      <p className="bot-skills-empty">
        {filtered
          ? "No skills match the filter."
          : "No additional skills available in the library."}
      </p>
    );
  }
  return (
    <ul className="bot-skills-list" aria-label="Available skills">
      {skills.map((sk) => (
        <li key={sk.name} className="bot-skills-row">
          <div className="bot-skills-row-body">
            <span className="bot-skills-row-name">{sk.title ?? sk.name}</span>
            <span className="bot-skills-row-slug">{sk.name}</span>
            {sk.description ? (
              <p className="bot-skills-row-desc">{sk.description}</p>
            ) : null}
          </div>
          <button
            type="button"
            className="bot-skills-row-add"
            disabled={addPending}
            onClick={() => onAdd(sk.name)}
            aria-label={`Add ${sk.title ?? sk.name} to @${agentSlug}`}
          >
            + Add
          </button>
        </li>
      ))}
    </ul>
  );
}

export function SkillsTab({ agentSlug }: SkillsTabProps) {
  const [mode, setMode] = useState<Mode>("enabled");
  const [filter, setFilter] = useState("");
  const queryClient = useQueryClient();

  const {
    data: allSkills = [],
    isLoading,
    isError,
  } = useQuery({
    queryKey: ["skills-list"],
    queryFn: () => getSkillsList("all").then((r) => r.skills ?? []),
    refetchInterval: 30_000,
  });

  const enabledSkills = allSkills.filter(
    (sk) =>
      Array.isArray(sk.owner_agents) && sk.owner_agents.includes(agentSlug),
  );

  const librarySkills = allSkills.filter(
    (sk) =>
      (sk.status === "active" || sk.status === "proposed") &&
      !(Array.isArray(sk.owner_agents) && sk.owner_agents.includes(agentSlug)),
  );

  const addMutation = useMutation({
    mutationFn: (name: string) => enableSkillForBot(name, agentSlug),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["skills-list"] });
    },
  });

  const removeMutation = useMutation({
    mutationFn: (name: string) => disableSkillForBot(name, agentSlug),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["skills-list"] });
    },
  });

  const filterLower = filter.toLowerCase().trim();

  function matchesFilter(sk: Skill): boolean {
    if (!filterLower) return true;
    return (
      (sk.name ?? "").toLowerCase().includes(filterLower) ||
      (sk.title ?? "").toLowerCase().includes(filterLower) ||
      (sk.description ?? "").toLowerCase().includes(filterLower)
    );
  }

  const visibleEnabled = enabledSkills.filter(matchesFilter);
  const visibleLibrary = librarySkills.filter(matchesFilter);

  return (
    <div className="bot-skills-tab" data-testid="skills-tab">
      {/* Header: title + Enabled / Library mode switch */}
      <div className="bot-skills-header">
        <div>
          <h2 className="bot-skills-title">Skills</h2>
          <p className="bot-skills-subtitle">
            Skills extend what @{agentSlug} can do. Enabled skills are injected
            into the agent's system prompt.
          </p>
        </div>

        <div
          className="bot-skills-mode-switch"
          role="tablist"
          aria-label="Skills view mode"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === "enabled"}
            className={`bot-skills-mode-btn${mode === "enabled" ? " bot-skills-mode-btn--active" : ""}`}
            onClick={() => setMode("enabled")}
          >
            Enabled
            <span className="bot-skills-mode-count">
              {enabledSkills.length}
            </span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "library"}
            className={`bot-skills-mode-btn${mode === "library" ? " bot-skills-mode-btn--active" : ""}`}
            onClick={() => setMode("library")}
          >
            Library
            <span className="bot-skills-mode-count">
              {librarySkills.length}
            </span>
          </button>
        </div>
      </div>

      {/* Search filter */}
      <div className="bot-skills-filter">
        <Search
          className="bot-skills-filter-icon"
          width={14}
          height={14}
          aria-hidden="true"
        />
        <input
          className="bot-skills-filter-input"
          type="text"
          placeholder={
            mode === "enabled" ? "Filter enabled skills…" : "Search library…"
          }
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter skills"
        />
      </div>

      {isLoading ? (
        <p className="bot-skills-empty">Loading skills…</p>
      ) : isError ? (
        <p className="bot-skills-empty" role="alert">
          Couldn't load skills. Check your connection and try again.
        </p>
      ) : mode === "enabled" ? (
        <EnabledSkillsGrid
          skills={visibleEnabled}
          agentSlug={agentSlug}
          filtered={!!filter}
          onRemove={(name) => removeMutation.mutate(name)}
          removePending={removeMutation.isPending}
        />
      ) : (
        <LibrarySkillsList
          skills={visibleLibrary}
          agentSlug={agentSlug}
          filtered={!!filter}
          onAdd={(name) => addMutation.mutate(name)}
          addPending={addMutation.isPending}
        />
      )}
    </div>
  );
}
