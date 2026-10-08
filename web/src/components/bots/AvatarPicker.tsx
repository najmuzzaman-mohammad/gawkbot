import { type CSSProperties, type KeyboardEvent, useId, useRef } from "react";

import type { AvatarShape, MemberAvatar } from "../../api/memberTypes";
import {
  AVATAR_COLOR_NAMES,
  AVATAR_COLORS,
  AVATAR_SHAPES,
  hasAvatarChoice,
  normalizeAvatarColor,
  resolveAvatar,
} from "../../lib/blobAvatar";
import { BlobAvatar } from "../ui/BlobAvatar";

import "../../styles/avatar-picker.css";

// Pick a bot's look: one of the office's eight species and a body
// colour. `value` undefined means AUTOMATIC: the look derived from the slug,
// which is what every bot had before avatars were pickable. Each field is
// independent, so picking only a shape keeps the derived colour (and vice
// versa), matching how the broker resolves a partial avatar.
//
// Both groups are native radio groups (a fieldset of same-named radio
// inputs), so Tab enters each group once, on the checked item, and screen
// readers announce "radio, n of 8". Arrow keys move and select, wrapping, and
// Home/End jump; that is handled here rather than left to the browser so it
// behaves the same everywhere. The custom colour is a native colour input,
// its own tab stop after the palette.

const SHAPE_LABELS: Record<AvatarShape, string> = {
  block: "Block",
  dome: "Dome",
  drop: "Drop",
  bean: "Bean",
  pill: "Pill",
  loaf: "Loaf",
  shield: "Shield",
  blob: "Blob",
};

export interface AvatarPickerProps {
  /** The bot's slug: drives the automatic look and every preview. */
  slug: string;
  /** The chosen look; undefined (or empty) means automatic. */
  value: MemberAvatar | undefined;
  /** Called with the next look, or undefined for "Reset to automatic". */
  onChange: (next: MemberAvatar | undefined) => void;
  disabled?: boolean;
}

/** Drops empty fields so `{}` never leaks out as a "choice". */
function compact(avatar: MemberAvatar): MemberAvatar | undefined {
  const out: MemberAvatar = {};
  if (avatar.shape) out.shape = avatar.shape;
  const color = normalizeAvatarColor(avatar.color);
  if (color) out.color = color;
  return out.shape || out.color ? out : undefined;
}

/**
 * Arrow/Home/End handling for a radio group of `count` items. Returns the
 * index to move to, or null when the key is not a navigation key.
 */
function nextIndex(key: string, from: number, count: number): number | null {
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (from + 1) % count;
    case "ArrowLeft":
    case "ArrowUp":
      return (from - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

export function AvatarPicker({
  slug,
  value,
  onChange,
  disabled = false,
}: AvatarPickerProps) {
  const id = useId();
  const shapeRefs = useRef<(HTMLInputElement | null)[]>([]);
  const colorRefs = useRef<(HTMLInputElement | null)[]>([]);

  // A bot with no slug yet (a blank wizard) still previews something.
  const previewSlug = slug.trim() || "new-bot";
  const automatic = !hasAvatarChoice(value);
  const look = resolveAvatar(previewSlug, value);
  const paletteIndex = AVATAR_COLORS.indexOf(look.color);
  const customColor = paletteIndex < 0;

  const pickShape = (shape: AvatarShape) =>
    onChange(compact({ ...value, shape }));
  const pickColor = (color: string) => onChange(compact({ ...value, color }));

  const onShapeKey = (e: KeyboardEvent<HTMLInputElement>, i: number) => {
    const to = nextIndex(e.key, i, AVATAR_SHAPES.length);
    if (to === null) return;
    e.preventDefault();
    pickShape(AVATAR_SHAPES[to]);
    shapeRefs.current[to]?.focus();
  };
  const onColorKey = (e: KeyboardEvent<HTMLInputElement>, i: number) => {
    const to = nextIndex(e.key, i, AVATAR_COLORS.length);
    if (to === null) return;
    e.preventDefault();
    pickColor(AVATAR_COLORS[to]);
    colorRefs.current[to]?.focus();
  };

  return (
    <div className="avatar-picker" data-automatic={automatic || undefined}>
      <div className="avatar-picker-head">
        <span className="avatar-picker-preview">
          <BlobAvatar
            slug={previewSlug}
            size={56}
            avatar={value}
            label={`Avatar preview: ${SHAPE_LABELS[AVATAR_SHAPES[look.shapeIndex]]}`}
          />
        </span>
        <div className="avatar-picker-meta">
          <span className="avatar-picker-mode" aria-live="polite">
            {automatic ? "Automatic" : "Custom look"}
          </span>
          <span className="avatar-picker-hint">
            {automatic
              ? "Picked from the bot's slug. Choose a shape or colour to make it yours."
              : "Shape and colour show everywhere this bot appears."}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-sm avatar-picker-reset"
            onClick={() => onChange(undefined)}
            disabled={disabled || automatic}
          >
            Reset to automatic
          </button>
        </div>
      </div>

      <fieldset className="avatar-picker-group" disabled={disabled}>
        <legend className="avatar-picker-label">Shape</legend>
        <div className="avatar-picker-shapes">
          {AVATAR_SHAPES.map((shape, i) => {
            const checked = i === look.shapeIndex;
            return (
              <label
                key={shape}
                className="avatar-picker-shape"
                data-checked={checked || undefined}
                data-shape={shape}
              >
                <input
                  ref={(el) => {
                    shapeRefs.current[i] = el;
                  }}
                  type="radio"
                  className="sr-only"
                  name={`${id}-shape`}
                  value={shape}
                  aria-label={SHAPE_LABELS[shape]}
                  checked={checked}
                  onChange={() => pickShape(shape)}
                  onKeyDown={(e) => onShapeKey(e, i)}
                />
                <BlobAvatar
                  slug={previewSlug}
                  size={30}
                  avatar={{ shape, color: look.color }}
                />
              </label>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="avatar-picker-group" disabled={disabled}>
        <legend className="avatar-picker-label">Colour</legend>
        <div className="avatar-picker-colors">
          {AVATAR_COLORS.map((color, i) => (
            <label
              key={color}
              className="avatar-picker-swatch"
              data-checked={i === paletteIndex || undefined}
              data-color={color}
              style={{ "--avatar-swatch": color } as CSSProperties}
            >
              <input
                ref={(el) => {
                  colorRefs.current[i] = el;
                }}
                type="radio"
                className="sr-only"
                name={`${id}-color`}
                value={color}
                aria-label={AVATAR_COLOR_NAMES[i] ?? color}
                checked={i === paletteIndex}
                onChange={() => pickColor(color)}
                onKeyDown={(e) => onColorKey(e, i)}
              />
            </label>
          ))}
          <label
            className="avatar-picker-custom"
            data-checked={customColor || undefined}
            style={{ "--avatar-swatch": look.color } as CSSProperties}
          >
            <input
              type="color"
              className="avatar-picker-custom-input"
              aria-label="Custom colour"
              value={look.color}
              disabled={disabled}
              onChange={(e) => pickColor(e.target.value)}
            />
            <span className="avatar-picker-custom-text">Custom</span>
          </label>
        </div>
      </fieldset>
    </div>
  );
}
