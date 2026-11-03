import type { CSSProperties, ReactNode } from "react";

const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 140px) minmax(0, 280px)",
  alignItems: "center",
  columnGap: "var(--space-4)",
  rowGap: "var(--space-1)",
  padding: "var(--space-4)",
  border: "var(--border-width-sm) solid var(--border)",
  borderRadius: "var(--radius-md)",
  background: "var(--bg-card)",
};

const labelStyle: CSSProperties = {
  color: "var(--text-secondary)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
};

export interface StoryGridProps {
  children: ReactNode;
}

/** A two-column "label, value" sheet on the card surface. Stories only. */
export function StoryGrid({ children }: StoryGridProps) {
  return <div style={gridStyle}>{children}</div>;
}

export interface StoryRowProps {
  label: string;
  children: ReactNode;
}

export function StoryRow({ label, children }: StoryRowProps) {
  return (
    <>
      <span style={labelStyle}>{label}</span>
      <div style={{ minWidth: 0 }}>{children}</div>
    </>
  );
}
