import type { CSSProperties } from "react";

import type { MemberLook } from "../../api/memberTypes";
import { ORB_VIEWBOX } from "../../lib/orbAvatar";
import { type LookPart, lookParts } from "../../lib/orbLook";

export interface OrbLookOverlayProps {
  look: MemberLook | undefined | null;
  bodyColor: string;
  size: number;
  style?: CSSProperties;
}

const INK = "#1a1a1f";

function Hair({ id, color }: LookPart) {
  switch (id) {
    case "tuft":
      return (
        <path
          d="M88 18 C 92 2, 108 2, 112 18 C 104 12, 96 12, 88 18 Z"
          fill={color}
        />
      );
    case "bob":
      return (
        <path
          d="M26 70 C 30 20, 170 20, 174 70 C 160 48, 40 48, 26 70 Z"
          fill={color}
        />
      );
    case "mohawk":
      return (
        <>
          <path d="M86 24 L 100 -14 L 114 24 Z" fill={color} />
          <path d="M96 26 L 100 -2 L 104 26 Z" fill={color} opacity={0.6} />
        </>
      );
    case "curls":
      return (
        <g fill={color}>
          <circle cx={60} cy={36} r={14} />
          <circle cx={84} cy={22} r={15} />
          <circle cx={110} cy={20} r={15} />
          <circle cx={136} cy={32} r={14} />
          <circle cx={156} cy={54} r={12} />
          <circle cx={44} cy={58} r={12} />
        </g>
      );
    case "cap":
      return (
        <>
          <path d="M34 60 C 40 14, 160 14, 166 60 Z" fill={color} />
          <path
            d="M28 60 L 184 60 L 190 72 L 22 72 Z"
            fill={color}
            opacity={0.85}
          />
        </>
      );
    default:
      return null;
  }
}

function Eyes({ id }: LookPart) {
  switch (id) {
    case "glasses":
      return (
        <g fill="none" stroke={INK} strokeWidth={5}>
          <circle cx={74} cy={96} r={20} />
          <circle cx={126} cy={96} r={20} />
          <path d="M94 96 L 106 96" />
          <path d="M54 92 L 40 86" />
          <path d="M146 92 L 160 86" />
        </g>
      );
    case "wink":
      return (
        <path
          d="M112 96 C 120 90, 132 90, 140 96"
          fill="none"
          stroke={INK}
          strokeWidth={6}
          strokeLinecap="round"
        />
      );
    case "sparkle":
      return (
        <g fill="#ffffff">
          <path d="M138 70 l 3 7 l 7 3 l -7 3 l -3 7 l -3 -7 l -7 -3 l 7 -3 Z" />
          <path d="M58 64 l 2 5 l 5 2 l -5 2 l -2 5 l -2 -5 l -5 -2 l 5 -2 Z" />
        </g>
      );
    default:
      return null;
  }
}

function Accessory({ id, color }: LookPart) {
  switch (id) {
    case "bow":
      return (
        <g fill={color}>
          <path d="M136 30 L 160 20 L 158 44 Z" />
          <path d="M136 30 L 112 20 L 114 44 Z" />
          <circle cx={136} cy={31} r={6} />
        </g>
      );
    case "tie":
      return (
        <g fill={color}>
          <path d="M92 150 L 108 150 L 100 160 Z" />
          <path d="M94 158 L 106 158 L 104 190 L 96 190 Z" />
        </g>
      );
    case "headphones":
      return (
        <>
          <path
            d="M34 100 C 34 40, 166 40, 166 100"
            fill="none"
            stroke={INK}
            strokeWidth={8}
            strokeLinecap="round"
          />
          <rect x={22} y={92} width={22} height={34} rx={8} fill={INK} />
          <rect x={156} y={92} width={22} height={34} rx={8} fill={INK} />
        </>
      );
    case "scarf":
      return (
        <g fill={color}>
          <path d="M40 150 C 70 172, 130 172, 160 150 L 158 166 C 130 186, 70 186, 42 166 Z" />
          <path d="M118 166 L 136 206 L 152 198 L 136 160 Z" />
        </g>
      );
    case "antenna":
      return (
        <>
          <path
            d="M100 20 L 100 -6"
            stroke={INK}
            strokeWidth={5}
            strokeLinecap="round"
          />
          <circle cx={100} cy={-10} r={8} fill={color} />
        </>
      );
    default:
      return null;
  }
}

/**
 * The character's hair, eyes, and accessory over the orb: a sibling <svg>
 * laid exactly over the orb's, in the same viewbox, with pointer events
 * off so the orb still takes the tap. Nothing for no look.
 */
export function OrbLookOverlay({
  look,
  bodyColor,
  size,
  style,
}: OrbLookOverlayProps) {
  const parts = lookParts(look, bodyColor);
  if (parts.length === 0) return null;
  return (
    <svg
      className="orb-look"
      viewBox={ORB_VIEWBOX}
      width={size}
      height={size}
      overflow="visible"
      aria-hidden="true"
      focusable="false"
      data-testid="orb-look"
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        ...style,
      }}
    >
      {parts.map((p) => (
        <g key={p.kind} data-layer={`${p.kind}:${p.id}`}>
          {p.kind === "hair" ? (
            <Hair {...p} />
          ) : p.kind === "eyes" ? (
            <Eyes {...p} />
          ) : (
            <Accessory {...p} />
          )}
        </g>
      ))}
    </svg>
  );
}
