// Regenerates everything on the website and in the apps that is drawn
// from the toons: the website sprite (the cast as still marks, each with
// a narrowed-eyes twin for blinking), the favicons, the Mac and iOS app
// icons and the OG image.
//
//   node scripts/brand-assets.mjs
//
// Bundles web/src/lib/toonBake.ts (the rig drawn still) and runs it in
// headless Chromium, so the marks are the app's own drawing. The brand's
// look must match BRAND_AVATAR in web/src/lib/orbAvatar.ts; change both
// together.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const R = join(dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = await import(
  join(R, "web/node_modules/playwright/index.mjs")
);

// gawkbot palette (web/src/lib/blobAvatar.ts): coral 0, tangerine 1, butter 2,
// lime 3, mint 4, aqua 5, sky 6, indigo 7, lavender 8, pink 9, rose 10, slate 11.
const C = [
  "#ff7a59",
  "#ffa53d",
  "#f2c94c",
  "#9ad44e",
  "#45cfa0",
  "#3cc3df",
  "#5aa9ff",
  "#7b7dff",
  "#b48cff",
  "#ff79c6",
  "#ff6b8b",
  "#8ea0b8",
];
// The brand: the sky-blue daisy, db-migrate's look in "they gang up".
const BRAND = { body: "flower", color: C[6] };
// The cast on the site, each with where it looks at rest (-1..1).
const CAST = {
  brand: { ...BRAND, yaw: 0, pitch: 0 },
  "auth-refactor": { body: "lemon", color: C[10], yaw: -0.5, pitch: 0.3 },
  "flaky-tests": { body: "ghost", color: C[5], yaw: 0.4, pitch: 0.1 },
  "landing-copy": { body: "drop", color: C[1], yaw: -0.3, pitch: -0.3 },
  changelog: { body: "seacow", color: C[3], yaw: 0.6, pitch: 0 },
  "test-fixer": { body: "stack", color: C[7], yaw: -0.6, pitch: 0.2 },
  "release-train": { body: "cloud", color: C[8], yaw: 0.3, pitch: -0.4 },
  "db-migrate": { body: "flower", color: C[6], yaw: -0.2, pitch: 0.4 },
  "ui-polish": { body: "bear", color: C[2], yaw: 0.5, pitch: -0.2 },
};

// The icon tile: poster paper, a little warmer at the bottom.
const PAPER_TOP = "#f6e8c8";
const PAPER_BOTTOM = "#e8d0a2";
const INK = "#1b1511";

// ── the rig, bundled ─────────────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), "gawk-bake-"));
execFileSync(
  "bun",
  ["build", join(R, "web/src/lib/toonBake.ts"), "--outdir", tmp, "--target", "browser", "--format", "iife"],
  { stdio: "inherit" },
);
const bundle = readFileSync(join(tmp, "toonBake.js"), "utf8");

const b = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium",
});
const page = await (await b.newContext({ deviceScaleFactor: 1 })).newPage();
page.on("pageerror", (e) => console.log("pageerror", e.message));
await page.setContent(
  `<!doctype html><body><script>${bundle}</script></body>`,
);
await page.addStyleTag({ content: "body{margin:0}" });

// ── sprite ───────────────────────────────────────────────────────────
const symbols = await page.evaluate((cast) => {
  const bake = (id, look, pose) =>
    window.GawkBake.bakeMark(look, pose)
      .replace(
        /^<svg[^>]*viewBox="([^"]+)"[^>]*>/,
        `<symbol id="${id}" viewBox="$1" overflow="visible">`,
      )
      .replace(/<\/svg>$/, "</symbol>");
  const lines = [];
  for (const [slug, look] of Object.entries(cast)) {
    lines.push(`  ${bake(`b-${slug}`, look, {})}`);
    lines.push(`  ${bake(`b-${slug}-n`, look, { lid: 0.85 })}`);
  }
  return lines;
}, CAST);

const HEADER = `<!-- The bot characters: 1930s cartoon toons, baked from web/src/lib/toon
     (the same drawing the app does). Each has a "-n" twin with closed eyes,
     for blinking. Regenerate rather than edit: the symbols are output. -->\n`;
for (const file of ["index.html", "download.html"]) {
  const path = `${R}/website/${file}`;
  let html = readFileSync(path, "utf8");
  const start = html.indexOf('<svg class="sprite"');
  const end = html.indexOf("</svg>", start) + "</svg>".length;
  if (start < 0 || end < start) throw new Error(`${file}: no sprite`);
  const used = new Set(
    [...html.matchAll(/href="#b-([a-z-]+?)(?:-n)?"/g)].map((m) => m[1]),
  );
  const keep = symbols.filter((s) =>
    used.has(/id="b-([a-z-]+?)(?:-n)?"/.exec(s)[1]),
  );
  const sprite = `<svg class="sprite" width="0" height="0" aria-hidden="true" focusable="false">\n${keep.join("\n")}\n</svg>`;
  const head = html
    .slice(0, start)
    .replace(/<!-- The bot characters[\s\S]*?-->\n/, HEADER);
  html = head + sprite + html.slice(end);
  writeFileSync(path, html);
  console.log(file, [...used].join(" "));
}

// ── brand marks ──────────────────────────────────────────────────────
const favicon = await page.evaluate(
  (look) => window.GawkBake.bakeMark(look, {}),
  CAST.brand,
);
writeFileSync(`${R}/website/favicon.svg`, `${favicon}\n`);
writeFileSync(`${R}/web/public/favicon.svg`, `${favicon}\n`);

// Raster: draw the baked svg onto a canvas, optionally on an app-icon tile.
async function png(file, size, opts) {
  const data = await page.evaluate(
    async ({ svg, size: px, opts: o, paper, ink }) => {
      const cv = document.createElement("canvas");
      cv.width = cv.height = px;
      const ctx = cv.getContext("2d");
      if (o.tile) {
        // The tile: a rounded square (corners masked by the OS on iOS;
        // drawn here for the Mac and the web) of poster paper with an ink
        // keyline inside the edge, the way a 1930s lobby card was framed.
        const r = px * (o.radius ?? 0.2237);
        ctx.beginPath();
        ctx.roundRect(0, 0, px, px, r);
        ctx.closePath();
        const g = ctx.createLinearGradient(0, 0, 0, px);
        g.addColorStop(0, paper[0]);
        g.addColorStop(1, paper[1]);
        ctx.fillStyle = g;
        ctx.fill();
        ctx.save();
        ctx.clip();
        const vig = ctx.createRadialGradient(px / 2, px / 2, px * 0.3, px / 2, px / 2, px * 0.75);
        vig.addColorStop(0, "rgba(60,30,10,0)");
        vig.addColorStop(1, "rgba(60,30,10,0.28)");
        ctx.fillStyle = vig;
        ctx.fillRect(0, 0, px, px);
        const inset = px * 0.07;
        ctx.beginPath();
        ctx.roundRect(inset, inset, px - inset * 2, px - inset * 2, Math.max(0, r - inset * 0.8));
        ctx.lineWidth = px * 0.012;
        ctx.strokeStyle = ink;
        ctx.stroke();
        ctx.restore();
      }
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      });
      const k = o.scale ?? 1;
      const w = px * k;
      const x = (px - w) / 2;
      const y = (px - w) / 2 + px * (o.dy ?? 0);
      ctx.drawImage(img, x, y, w, w);
      return cv.toDataURL("image/png");
    },
    {
      svg: favicon.replace("<svg ", '<svg width="1024" height="1024" '),
      size,
      opts,
      paper: [PAPER_TOP, PAPER_BOTTOM],
      ink: INK,
    },
  );
  writeFileSync(file, Buffer.from(data.split(",")[1], "base64"));
  console.log("wrote", file);
}
await png(`${R}/website/favicon-32.png`, 32, {});
await png(`${R}/website/favicon-96.png`, 96, {});
await png(`${R}/web/public/favicon-32.png`, 32, {});
await png(`${R}/website/apple-touch-icon.png`, 180, {
  tile: true,
  radius: 0,
  scale: 0.7,
  dy: 0.01,
});
await png(`${R}/web/public/apple-touch-icon.png`, 180, {
  tile: true,
  radius: 0,
  scale: 0.7,
  dy: 0.01,
});
await png(`${R}/desktop/oswails/build/appicon.png`, 1024, {
  tile: true,
  scale: 0.68,
  dy: 0.01,
});
await png(
  `${R}/apps/ios/Gawkbot/Assets.xcassets/AppIcon.appiconset/AppIcon.png`,
  1024,
  { tile: true, radius: 0, scale: 0.7, dy: 0.01 },
);

// ── OG image ─────────────────────────────────────────────────────────
await page.setViewportSize({ width: 1200, height: 630 });
await page.setContent(`<!doctype html><html><head><style>
  html,body{margin:0;width:1200px;height:630px;overflow:hidden}
  body{background:linear-gradient(180deg,${PAPER_TOP},${PAPER_BOTTOM});font-family:"Rockwell","American Typewriter","Roboto Slab",Georgia,serif;color:${INK};display:flex;align-items:center;justify-content:center;position:relative}
  .vig{position:absolute;inset:0;background:radial-gradient(70% 80% at 50% 50%,transparent 50%,rgba(60,30,10,.35) 100%)}
  .frame{position:absolute;inset:28px;border:6px solid ${INK};border-radius:18px}
  .wrap{position:relative;display:flex;align-items:center;gap:56px}
  .mark{width:320px;height:320px}
  h1{margin:0;font:800 116px/1 "Rockwell","American Typewriter","Roboto Slab",Georgia,serif;letter-spacing:-.02em}
  p{margin:14px 0 0;font:600 32px/1.25 -apple-system,Inter,sans-serif;color:#5a3f2c;max-width:620px}
  .tag{display:inline-block;margin-top:22px;padding:8px 16px;border-radius:999px;background:#c9402c;color:#fff4dd;font:700 22px -apple-system,Inter,sans-serif;box-shadow:0 0 0 3px ${INK}}
</style></head><body><div class="vig"></div><div class="frame"></div><div class="wrap">
  <div class="mark">${favicon.replace("<svg ", '<svg width="320" height="320" ')}</div>
  <div><h1>gawkbot</h1><p>Never leave your agents hanging. Every coding agent's questions, in your Mac's notch.</p><span class="tag">Free · Open source · Mac + iPhone</span></div>
</div></body></html>`);
await page.screenshot({ path: `${R}/website/og-image.png`, type: "png" });
console.log("wrote og-image.png");
await b.close();
