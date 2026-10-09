// glove.ts — the white cartoon glove: a round palm, fat fingers, a rolled
// cuff and three stitches on the back, in a handful of poses.
//
// Drawn in glove units with the wrist at the origin and the hand reaching
// along +x, thumb toward -y. A glove is a set of circles and capsules; the
// outline is the union of them all, drawn by laying every shape down twice:
// once fattened in ink, then once in white on top. Where shapes overlap the
// ink is covered, so only the outer silhouette is inked, the way a cel
// painter would ink it. Interior lines (stitches, the gaps between fingers)
// are drawn last.

export type GlovePose = "open" | "fist" | "point" | "thumb" | "grip" | "flat";

type Circle = { c: [number, number, number] };
type Capsule = { k: [number, number, number, number, number] };
type Shape = Circle | Capsule;

const LW = 2.6;

function finger(angleDeg: number, len: number, w = 10.4): Capsule {
  const a = (angleDeg * Math.PI) / 180;
  const ox = 19;
  return {
    k: [
      ox + Math.cos(a) * 6,
      Math.sin(a) * 6,
      ox + Math.cos(a) * len,
      Math.sin(a) * len,
      w,
    ],
  };
}

const CUFF: Capsule = { k: [2, -11.5, 2, 11.5, 13] };

const FIST: Shape[] = [
  CUFF,
  { c: [20, 0, 13.5] },
  { c: [30, -8.5, 6.6] },
  { c: [33.5, -0.5, 6.6] },
  { c: [30.5, 7.8, 6.4] },
];

const POSES: Record<GlovePose, { shapes: Shape[]; lines: string }> = {
  open: {
    shapes: [
      CUFF,
      { c: [19, 0, 12.5] },
      finger(-30, 26),
      finger(-6, 28.5),
      finger(18, 26),
      finger(-80, 21, 10.4),
    ],
    lines: "M12 -4.5 L18 -5 M12.5 0 L19 0 M12 4.5 L18 5",
  },
  flat: {
    // Fingers together, a mitten-like slab: for pushing, wiping, clapping.
    shapes: [
      CUFF,
      { c: [19, 0, 12.5] },
      finger(-12, 30, 9),
      finger(0, 32, 9),
      finger(12, 30, 9),
      finger(-70, 20, 9),
    ],
    lines: "M24 -3.5 L38 -5.5 M24 3.5 L38 5.5",
  },
  fist: {
    shapes: [...FIST, { k: [16, -11.5, 27, -9.5, 8.4] }],
    lines: "M29 -4 L35.5 -4.5 M29 3.6 L35.5 4",
  },
  grip: {
    // A fist closed round something (a cord, a bar) held along -y.
    shapes: [...FIST, { k: [17, -12, 25, -13.5, 8.4] }],
    lines: "M29 -4 L35.5 -4.5 M29 3.6 L35.5 4",
  },
  point: {
    shapes: [...FIST, { k: [27, -7, 47, -7.5, 8.2] }],
    lines: "M29 0.5 L35.5 1 M29 5 L34.5 5.6",
  },
  thumb: {
    shapes: [...FIST, { k: [21, -10, 21, -29, 8.8] }],
    lines: "M29 -4 L35.5 -4.5 M29 3.6 L35.5 4",
  },
};

function layer(shapes: Shape[], fill: string, grow: number): string {
  return shapes
    .map((s) => {
      if ("c" in s) {
        const [x, y, r] = s.c;
        return `<circle cx="${x}" cy="${y}" r="${r + grow}" fill="${fill}"/>`;
      }
      const [x1, y1, x2, y2, w] = s.k;
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${fill}" stroke-width="${w + grow * 2}" stroke-linecap="round"/>`;
    })
    .join("");
}

/** SVG markup for a glove in `pose`, in glove units (wrist at 0 0). */
export function gloveMarkup(
  pose: GlovePose,
  white: string,
  ink: string,
): string {
  const p = POSES[pose];
  return (
    layer(p.shapes, ink, LW) +
    layer(p.shapes, white, 0) +
    `<path d="M3 -8 Q7 0 3 8 ${p.lines}" fill="none" stroke="${ink}" stroke-width="1.8" stroke-linecap="round" opacity="0.85"/>`
  );
}
