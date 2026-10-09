import type { Meta, StoryObj } from "@storybook/react-vite";
import { Plus, RefreshCw, Settings, X } from "lucide-react";

const meta: Meta = {
  title: "Design System/Atoms/IconButton",
  parameters: { layout: "padded" },
};

export default meta;

export const Sizes: StoryObj = {
  render: () => (
    <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        aria-label="Close"
      >
        <X size={14} />
      </button>
      <button type="button" className="icon-btn" aria-label="Settings">
        <Settings size={18} />
      </button>
      <button type="button" className="icon-btn icon-btn--lg" aria-label="Add">
        <Plus size={22} />
      </button>
    </div>
  ),
};

export const States: StoryObj = {
  render: () => (
    <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
      <button type="button" className="icon-btn" aria-label="Default">
        <RefreshCw size={18} />
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-label="Disabled"
        disabled={true}
      >
        <RefreshCw size={18} />
      </button>
    </div>
  ),
};

export const InContext: StoryObj = {
  name: "In context",
  render: () => (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "var(--space-3) var(--space-4)",
        background: "var(--bg-card)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-md)",
        maxWidth: 480,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column" }}>
        <span style={{ color: "var(--text)", fontWeight: 600 }}>
          #architecture
        </span>
        <span style={{ color: "var(--text-tertiary)", fontSize: 12 }}>
          12 bots, 3 humans
        </span>
      </div>
      <div style={{ display: "flex", gap: 4 }}>
        <button type="button" className="icon-btn" aria-label="Refresh">
          <RefreshCw size={18} />
        </button>
        <button type="button" className="icon-btn" aria-label="Settings">
          <Settings size={18} />
        </button>
        <button type="button" className="icon-btn" aria-label="Close">
          <X size={18} />
        </button>
      </div>
    </header>
  ),
};
