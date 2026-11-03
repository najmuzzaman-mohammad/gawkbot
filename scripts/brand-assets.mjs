// Regenerates everything on the website and in the apps that is drawn from
// the orb: the website sprite (the cast, each with a narrowed-eyes twin for
// blinking), the favicons, the Mac and iOS app icons and the OG image.
//
//   node scripts/brand-assets.mjs
//
// Runs the vendored orb core in headless Chromium, because baking the goo
// into a plain path needs a canvas. The brand's look must match
// BRAND_AVATAR in web/src/lib/orbAvatar.ts; change both together.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const R = join(dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = await import(
  join(R, "web/node_modules/playwright/index.mjs")
);
const CORE = `${R}/web/src/vendor/orb-mascot/core.js`;

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
// The brand: the sky-blue flower, db-migrate's look in "they gang up".
const BRAND = { body: "flower", color: C[6] };
// The brand colour as an rgb triple, for the glow on the app icon tile.
const BRAND_RGB = "90,169,255";
// The cast on the site, each with where it looks (yaw, pitch) at rest.
const CAST = {
  brand: { ...BRAND, yaw: 0, pitch: 0 },
  "auth-refactor": { body: "lemon", color: C[10], yaw: -10, pitch: 4 },
  "flaky-tests": { body: "ghost", color: C[5], yaw: 8, pitch: 2 },
  "landing-copy": { body: "drop", color: C[1], yaw: -6, pitch: -4 },
  changelog: { body: "seacow", color: C[3], yaw: 12, pitch: 0 },
  "test-fixer": { body: "stack", color: C[7], yaw: -12, pitch: 3 },
  "release-train": { body: "cloud", color: C[8], yaw: 6, pitch: -6 },
  "db-migrate": { body: "flower", color: C[6], yaw: -4, pitch: 6 },
  "ui-polish": { body: "bear", color: C[2], yaw: 10, pitch: -3 },
};

const b = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium",
});
const page = await (await b.newContext({ deviceScaleFactor: 1 })).newPage();
page.on("pageerror", (e) => console.log("pageerror", e.message));
await page.setContent(
  `<!doctype html><body><script>${readFileSync(CORE, "utf8")}</script></body>`,
);
await page.addStyleTag({ content: "body{margin:0}" });

// ── sprite ───────────────────────────────────────────────────────────
const symbols = await page.evaluate((cast) => {
  const NS = "http://www.w3.org/2000/svg";
  const bake = (id, look, blink) => {
    const svg = document.createElementNS(NS, "svg");
    const m = new window.Mascot(svg, {
      preset: "avatar",
      body: look.body,
      color: look.color,
      shade: "gradient",
      lean: false,
    });
    m.manual = true;
    m.snap(look.yaw, look.pitch);
    m.setNow({ blink });
    m.render();
    const out = m.toSVG({ size: 240, id });
    // <svg ...> → <symbol ...>: keep the viewBox, drop the xml header.
    return out
      .replace(/^<\?xml[^>]*>\s*/, "")
      .replace(
        /^<svg[^>]*viewBox="([^"]+)"[^>]*>/,
        `<symbol id="${id}" viewBox="$1" overflow="visible">`,
      )
      .replace(/<\/svg>$/, "</symbol>");
  };
  const lines = [];
  for (const [slug, look] of Object.entries(cast)) {
    lines.push(`  ${bake(`b-${slug}`, look, 0)}`);
    lines.push(`  ${bake(`b-${slug}-n`, look, 0.85)}`);
  }
  return lines;
}, CAST);

const HEADER = `<!-- The bot characters: Nex's orbs, baked from web/src/vendor/orb-mascot
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
  // Every use site draws in the orb's box now.
  html = html.replace(
    /(<svg class="blob[^"]*"[^>]*?)viewBox="0 0 (?:64 64|16 16)"/g,
    '$1viewBox="-24 -24 248 248"',
  );
  writeFileSync(path, html);
  console.log(file, [...used].join(" "));
}

// ── brand marks ──────────────────────────────────────────────────────
const brandSvg = await page.evaluate((look) => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const m = new window.Mascot(svg, {
    preset: "avatar",
    body: look.body,
    color: look.color,
    shade: "gradient",
    lean: false,
  });
  m.manual = true;
  m.snap(0, 0);
  m.render();
  return m.toSVG({ size: 240, id: "gawkbot" });
}, BRAND);
// A favicon that fills its box: crop the viewBox to the mark's own drawn
// extent, squared up and padded a little, whatever the body's shape.
const fit = await page.evaluate(async (svg) => {
  // Paint the mark and measure its opaque pixels: the SVG's own boxes
  // include filter regions, which are far larger than what is drawn.
  const clean = svg.replace(/^<\?xml[^>]*>\s*/, "");
  const vb = /viewBox="([^"]+)"/.exec(clean)[1].split(/\s+/).map(Number);
  const N = 1000;
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    clean.replace(/width="\d+" height="\d+"/, `width="${N}" height="${N}"`),
  )}`;
  await img.decode();
  const cv = document.createElement("canvas");
  cv.width = cv.height = N;
  const ctx = cv.getContext("2d");
  ctx.drawImage(img, 0, 0, N, N);
  const px = ctx.getImageData(0, 0, N, N).data;
  // Opaque rows and columns, then their first and last.
  const rows = [];
  const cols = new Set();
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (px[(y * N + x) * 4 + 3] > 8) {
        rows.push(y);
        cols.add(x);
      }
    }
  }
  const xs = [...cols];
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = rows[0];
  const y1 = rows[rows.length - 1];
  const k = vb[2] / N;
  const bx = vb[0] + x0 * k,
    by = vb[1] + y0 * k;
  const bw = (x1 - x0 + 1) * k,
    bh = (y1 - y0 + 1) * k;
  const side = Math.max(bw, bh) * 1.04;
  const r = (v) => Math.round(v * 10) / 10;
  return `${r(bx + bw / 2 - side / 2)} ${r(by + bh / 2 - side / 2)} ${r(side)} ${r(side)}`;
}, brandSvg);
const favicon = brandSvg
  .replace(/^<\?xml[^>]*>\s*/, "")
  .replace(/viewBox="[^"]+" width="\d+" height="\d+"/, `viewBox="${fit}"`);
writeFileSync(`${R}/website/favicon.svg`, `${favicon}\n`);
writeFileSync(`${R}/web/public/favicon.svg`, `${favicon}\n`);

// Raster: draw the baked svg onto a canvas, optionally on an app-icon tile.
async function png(file, size, opts) {
  const data = await page.evaluate(
    async ({ svg, size: px, opts: o, glow }) => {
      const cv = document.createElement("canvas");
      cv.width = cv.height = px;
      const ctx = cv.getContext("2d");
      if (o.tile) {
        // The macOS/iOS tile: a rounded square (corners masked by the OS on
        // iOS; drawn here for the Mac and the web) with a deep dusk gradient.
        const r = px * (o.radius ?? 0.2237);
        ctx.beginPath();
        ctx.roundRect(0, 0, px, px, r);
        ctx.closePath();
        const g = ctx.createLinearGradient(0, 0, 0, px);
        g.addColorStop(0, "#1d2340");
        g.addColorStop(1, "#0b0e1c");
        ctx.fillStyle = g;
        ctx.fill();
        ctx.save();
        ctx.clip();
        const halo = ctx.createRadialGradient(
          px * 0.5,
          px * 0.92,
          0,
          px * 0.5,
          px * 0.92,
          px * 0.7,
        );
        halo.addColorStop(0, `rgba(${glow},0.35)`);
        halo.addColorStop(1, `rgba(${glow},0)`);
        ctx.fillStyle = halo;
        ctx.fillRect(0, 0, px, px);
        ctx.restore();
      }
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      });
      const k = o.scale ?? 1,
        w = px * k,
        x = (px - w) / 2,
        y = (px - w) / 2 + px * (o.dy ?? 0);
      ctx.drawImage(img, x, y, w, w);
      return cv.toDataURL("image/png");
    },
    {
      svg: favicon.replace(
        `viewBox="${fit}"`,
        `viewBox="${fit}" width="1024" height="1024"`,
      ),
      size,
      opts,
      glow: BRAND_RGB,
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
  scale: 0.64,
  dy: 0.02,
});
await png(`${R}/web/public/apple-touch-icon.png`, 180, {
  tile: true,
  radius: 0,
  scale: 0.64,
  dy: 0.02,
});
await png(`${R}/desktop/oswails/build/appicon.png`, 1024, {
  tile: true,
  scale: 0.62,
  dy: 0.02,
});
await png(
  `${R}/apps/ios/Gawkbot/Assets.xcassets/AppIcon.appiconset/AppIcon.png`,
  1024,
  { tile: true, radius: 0, scale: 0.64, dy: 0.02 },
);

// ── OG image ─────────────────────────────────────────────────────────
await page.setViewportSize({ width: 1200, height: 630 });
await page.setContent(`<!doctype html><html><head><style>
  html,body{margin:0;width:1200px;height:630px;overflow:hidden}
  body{background:linear-gradient(160deg,#1d2340,#0b0e1c);font-family:Inter,"Inter Display",-apple-system,sans-serif;color:#fff;display:flex;align-items:center;justify-content:center}
  .glow{position:absolute;left:50%;top:60%;width:900px;height:900px;transform:translate(-50%,-50%);background:radial-gradient(circle,rgba(${BRAND_RGB},.28),rgba(${BRAND_RGB},0) 60%)}
  .wrap{position:relative;display:flex;align-items:center;gap:56px}
  .mark{width:300px;height:300px}
  h1{margin:0;font:800 104px/1 "Inter Display",Inter,sans-serif;letter-spacing:-.04em}
  p{margin:14px 0 0;font:500 34px/1.25 Inter,sans-serif;color:rgba(255,255,255,.78);max-width:620px}
  .tag{display:inline-block;margin-top:22px;padding:8px 14px;border-radius:999px;background:rgba(255,255,255,.1);font:600 22px Inter,sans-serif;color:${BRAND.color};border:1px solid rgba(255,255,255,.18)}
</style></head><body><div class="glow"></div><div class="wrap">
  <div class="mark">${favicon.replace("<svg ", '<svg width="300" height="300" ')}</div>
  <div><h1>gawkbot</h1><p>Never leave your agents hanging. Every coding agent's questions, in your Mac's notch.</p><span class="tag">Free · Open source · Mac + iPhone</span></div>
</div></body></html>`);
await page.screenshot({ path: `${R}/website/og-image.png`, type: "png" });
console.log("wrote og-image.png");
await b.close();
