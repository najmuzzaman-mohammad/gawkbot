import type { Meta, StoryObj } from "@storybook/react-vite";
import { Search, SlidersHorizontal } from "lucide-react";

/**
 * The macOS control set: capsule buttons at the regular 32px height, the
 * 24px small size, the toggle switch, the segmented control and the
 * toolbar capsule. All of it is CSS classes on native elements (see the
 * "macOS controls" block in styles/global.css), so forms, labels and tests
 * keep the semantics they already have.
 */
const meta: Meta = {
  title: "Design System/Atoms/macOS Controls",
  parameters: { layout: "padded" },
};

export default meta;

export const Buttons: StoryObj = {
  render: () => (
    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
      <button type="button" className="btn btn-primary">
        Start now
      </button>
      <button type="button" className="btn btn-ghost">
        Backlog
      </button>
      <button type="button" className="btn btn-danger">
        Delete
      </button>
      <button type="button" className="btn btn-ghost btn-sm">
        Small
      </button>
      <button type="button" className="btn btn-primary btn-lg">
        Hero action
      </button>
    </div>
  ),
};

export const Switch: StoryObj = {
  render: () => (
    <div style={{ display: "flex", gap: 20, alignItems: "center" }}>
      <label style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
        <input type="checkbox" className="switch" defaultChecked={true} />
        On
      </label>
      <label style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
        <input type="checkbox" className="switch" />
        Off
      </label>
      <label style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
        <input
          type="checkbox"
          className="switch"
          disabled={true}
          defaultChecked={true}
        />
        Disabled
      </label>
    </div>
  ),
};

export const Segmented: StoryObj = {
  render: () => (
    <div className="segmented" role="radiogroup" aria-label="View">
      <button
        type="button"
        role="radio"
        className="segmented-item"
        aria-checked="true"
      >
        Board
      </button>
      <button
        type="button"
        role="radio"
        className="segmented-item"
        aria-checked="false"
      >
        List
      </button>
      <button
        type="button"
        role="radio"
        className="segmented-item"
        aria-checked="false"
      >
        Timeline
      </button>
    </div>
  ),
};

export const ToolbarGroup: StoryObj = {
  render: () => (
    <div className="toolbar-group">
      <button type="button" className="sidebar-btn" aria-label="Filter">
        <SlidersHorizontal size={16} />
      </button>
      <button type="button" className="sidebar-btn" aria-label="Search">
        <Search size={16} />
      </button>
    </div>
  ),
};

export const Field: StoryObj = {
  render: () => (
    <div style={{ display: "grid", gap: 10, maxWidth: 320 }}>
      <input className="input" placeholder="Bot name" />
      <input className="input" value="Chief of Staff" readOnly={true} />
      <input className="input" placeholder="Disabled" disabled={true} />
    </div>
  ),
};
