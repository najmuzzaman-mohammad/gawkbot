import { type CSSProperties, type ReactNode, useId, useRef } from "react";

import { BLINK_MIN_SIZE, useAvatarBlink } from "../../lib/avatarBlink";
import type { AvatarChoice } from "../../lib/blobAvatar";
import {
  type Expression,
  GAWK_VIEW,
  type GawkMark,
  type GradientName,
  gawkMark,
  type Primitive,
} from "../../lib/gawkAvatar";

// A bot's character (lib/gawkAvatar.ts), rendered as SVG. One component for
// every surface: the sidebar, bylines, the notch, the picker, the phone's
// web views. It carries the motion hooks from styles/avatar-motion.css (the
// svg wobbles, the inner group squashes, the eyes blink) and the working
// gawk from global.css (`[data-working]` narrows the eyes on a loop).
//
// Large idle avatars join the page's single blink pool (lib/avatarBlink.ts);
// a working one is already moving its eyes.

/** One narrow-and-widen cycle of the working gawk. */
const GAWK_PERIOD_MS = 2600;
/** How far the working gawk narrows the eyes, as a scale of their height. */
const GAWK_MIN_SCALE = 0.42;

export interface BlobAvatarProps {
  slug: string;
  size: number;
  /** 1 wide open, 0 narrowed. Multiplies the expression's own eye height. */
  openness?: number;
  expression?: Expression;
  /**
   * True only for the bot that is PROCESSING RIGHT NOW, not merely online.
   * The eyes narrow and widen on a CSS loop; nothing else animates, so a
   * rail of a dozen idle bots is a dozen static marks.
   */
  working?: boolean;
  /** Join the page's blink pool when large and idle. On by default. */
  blink?: boolean;
  className?: string;
  /** Accessible name. Omit for a decorative mark. */
  label?: string;
  /** The bot's chosen look; unset fields fall back to the slug's own. */
  avatar?: AvatarChoice | null;
  style?: CSSProperties;
}

function paint(p: Primitive, ids: (name: GradientName) => string) {
  const fill = p.fill?.startsWith("url(#G-")
    ? `url(#${ids(p.fill.slice(7, -1) as GradientName)})`
    : (p.fill ?? (p.stroke ? "none" : undefined));
  return {
    fill,
    stroke: p.stroke,
    strokeWidth: p.stroke ? (p.strokeWidth ?? 2) : undefined,
    strokeLinecap: p.stroke ? ("round" as const) : undefined,
    strokeLinejoin: p.stroke ? ("round" as const) : undefined,
    opacity: p.opacity,
    className: p.className,
  };
}

function Prim({
  p,
  ids,
  clipId,
}: {
  p: Primitive;
  ids: (name: GradientName) => string;
  clipId: string;
}) {
  let el: ReactNode;
  const a = paint(p, ids);
  switch (p.kind) {
    case "path":
      el = <path d={p.d} {...a} />;
      break;
    case "circle":
      el = <circle cx={p.cx} cy={p.cy} r={p.r} {...a} />;
      break;
    case "ellipse":
      el = (
        <ellipse
          cx={p.cx}
          cy={p.cy}
          rx={p.rx}
          ry={p.ry}
          transform={
            p.rotate ? `rotate(${p.rotate} ${p.cx} ${p.cy})` : undefined
          }
          {...a}
        />
      );
  }
  // The clip goes on a group so a rotated element does not rotate the clip.
  return p.clipToBody ? <g clipPath={`url(#${clipId})`}>{el}</g> : el;
}

function Defs({
  mark,
  ids,
  clipId,
}: {
  mark: GawkMark;
  ids: (name: GradientName) => string;
  clipId: string;
}) {
  return (
    <defs>
      {(Object.keys(mark.gradients) as GradientName[]).map((name) => {
        const g = mark.gradients[name];
        const stops = g.stops.map((s) => (
          <stop
            key={s.offset}
            offset={s.offset}
            stopColor={s.color}
            stopOpacity={s.opacity}
          />
        ));
        return g.kind === "linear" ? (
          <linearGradient
            key={name}
            id={ids(name)}
            x1={g.geometry[0]}
            y1={g.geometry[1]}
            x2={g.geometry[2]}
            y2={g.geometry[3]}
          >
            {stops}
          </linearGradient>
        ) : (
          <radialGradient
            key={name}
            id={ids(name)}
            cx={g.geometry[0]}
            cy={g.geometry[1]}
            r={g.geometry[2]}
          >
            {stops}
          </radialGradient>
        );
      })}
      <clipPath id={clipId}>
        <path d={mark.body} />
      </clipPath>
    </defs>
  );
}

export function BlobAvatar({
  slug,
  size,
  openness = 1,
  expression = "calm",
  working = false,
  blink = true,
  className,
  label,
  avatar,
  style,
}: BlobAvatarProps) {
  const uid = useId().replace(/[^\w-]/g, "");
  const ids = (name: GradientName) => `gawk-${uid}-${name}`;
  const clipId = `gawk-${uid}-clip`;
  const svgRef = useRef<SVGSVGElement>(null);
  const mark = gawkMark(slug, { avatar, expression, openness });
  // Closed-eye expressions have nothing to blink.
  const canBlink = expression !== "happy";
  useAvatarBlink(
    svgRef,
    blink && canBlink && !working && size >= BLINK_MIN_SIZE,
  );

  const cls = className ? `avatar-motion ${className}` : "avatar-motion";
  const inline = {
    // Inline, so a wrapper rule such as `.message-avatar svg { width: 100% }`
    // sizes the box around the mark and not the mark itself.
    width: size,
    height: size,
    "--pixel-avatar-gawk-min": String(GAWK_MIN_SCALE),
    "--pixel-avatar-gawk-period": `${GAWK_PERIOD_MS}ms`,
    ...style,
  } as CSSProperties;
  const draw = (ps: readonly Primitive[], key: string) =>
    ps.map((p, i) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: a static, ordered list
      <Prim key={`${key}${i}`} p={p} ids={ids} clipId={clipId} />
    ));

  return (
    <svg
      ref={svgRef}
      className={cls}
      width={size}
      height={size}
      viewBox={`0 0 ${GAWK_VIEW} ${GAWK_VIEW}`}
      overflow="visible"
      data-slug={slug}
      data-shape={mark.shape}
      data-working={working && canBlink ? "true" : undefined}
      style={inline}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <Defs mark={mark} ids={ids} clipId={clipId} />
      <g className="avatar-motion-body">
        {draw(mark.behind, "b")}
        <path d={mark.body} fill={`url(#${ids("body")})`} />
        {draw(mark.shading, "s")}
        {draw(mark.eyes, "e")}
        {draw(mark.front, "f")}
      </g>
    </svg>
  );
}
