/* Orb mascot — a black sphere with two eyes that live on its 3D surface.
   Usage:  const m = new Mascot(svgElement, { eyeLon: 16 });
           m.look(yaw, pitch)   // degrees, positive = right / up
           m.blink()            // one blink
           m.set({ eyeScale: 1.2, squash: 0.5 })
   Call m.render() after changing values directly, or m.start() for the
   built-in loop (smoothing, idle wander, blinking, cursor follow). */
(function (global, factory) {                                   // UMD: <script> tag sets window.Mascot; bundlers get module.exports
  if (typeof module === 'object' && module.exports) module.exports = factory(global); else factory(global);
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
  const D2R = Math.PI / 180;
  let uid = 0;
  const NS = 'http://www.w3.org/2000/svg';
  const hex2 = h => { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map(c => c + c).join(''); const n = parseInt(h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const mix = (a, b, t) => '#' + a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0')).join('');
  const lum = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  // OKLab: perceptually uniform, so an equal lightness step looks equal on every hue
  const s2l = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const l2s = v => { v = Math.max(0, Math.min(1, v)); return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)); };
  const rgb2ok = ([r, g, b]) => { r = s2l(r); g = s2l(g); b = s2l(b);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), q = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * q, 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * q, 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * q]; };
  const ok2rgb = ([L, a, b]) => { const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, q = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
    return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * q, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * q, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * q]; };
  const inGamut = c => c.every(v => v > -0.002 && v < 1.002);
  const shiftL = (hex, dl) => { let [L, a, b] = rgb2ok(hex2(hex)); L = clamp01(L + dl); let c = ok2rgb([L, a, b]);
    for (let i = 0; i < 14 && !inGamut(c); i++) { a *= 0.85; b *= 0.85; c = ok2rgb([L, a, b]); }                  // out of gamut: pull chroma in, keep the lightness
    return '#' + c.map(v => l2s(v).toString(16).padStart(2, '0')).join(''); };
  // shader tints: the contrast budget is split by the room the colour has in each direction, so dark bodies get most of it as light, light bodies as shadow
  const tintOf = (hex, dir) => { const L = rgb2ok(hex2(hex))[0]; return shiftL(hex, dir > 0 ? Math.min(0.03 + 0.15 * (1 - L), 0.8 * (1 - L)) : -Math.min(0.04 + 0.05 * L, 0.8 * L)); };
  const el = (n, a) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); return e; };

  // body silhouettes, centred on (100,100); sphereR = radius of the inner sphere the eyes ride on
  const SHAPES = {
    circle:  R => ({ d: `M${100-R} 100a${R} ${R} 0 1 0 ${2*R} 0a${R} ${R} 0 1 0 ${-2*R} 0Z`, sphereR: R }),
    squircle:R => ({ surf: { rx: 1, ry: 1 }, d: polar(t => { const c=Math.cos(t), s=Math.sin(t); const k=Math.pow(Math.pow(Math.abs(c),4)+Math.pow(Math.abs(s),4),-0.25); return [R*0.98*k*c, R*0.98*k*s]; }), sphereR: R }),
    egg:     R => ({ surf: { cy: 0.06, rx: 0.9, ry: 0.98 }, d: polar(t => { const c=Math.cos(t), s=Math.sin(t); const up = s<0 ? -s : 0; return [R*0.94*c*(1-0.22*Math.pow(up,1.5)), R*(s<0 ? 1.03*s : 0.97*s)]; }), sphereR: R*0.9 }),
    pebble:  R => ({ surf: { rx: 0.95, ry: 0.92 }, d: polar(t => { const r=R*(0.98+0.05*Math.sin(3*t+0.6)+0.03*Math.cos(5*t)); return [r*Math.cos(t), r*Math.sin(t)]; }), sphereR: R*0.93 }),
  };
  // composed bodies: union of circles, joins filleted by `round`
  // composed bodies: union of circles, joins filleted by `round`.
  // anim(circles, k) returns the circles for this frame. k = { t, dt (s), yaw, pitch, vel (deg/s, smoothed), poke (1..0), twitch {i, p} | null, mem (per-instance scratch) }
  const S = Math.sin, PI2 = Math.PI * 2;
  // Pieces (every circle except `main`) sit on the head sphere and rotate with the head, which follows the gaze
  // at `head` of the angle through a spring (k = stiffness, d = damping). anim() adds idle motion on top:
  // k = { t, dt (s), vel (deg/s), poke (1..0), twitch {i, p} | null, mem }
  const COMPOSED = {
    bear:  { c: [[0,0.05,0.9],[-0.6,-0.62,0.32],[0.6,-0.62,0.32]], sphereR: 0.88, surf: { cy: 0.05 }, main: 0, head: 0.35, k: 60, d: 14,
      anim: (c, k) => c.map(([x, y, r], i) => {
        if (i === 0) return [x, y, r];
        let dx = 0, dr = 0;
        if (k.twitch && k.twitch.i === i) { const p = k.twitch.p, env = Math.pow(S(p * Math.PI), 0.6); dx = S(p * PI2) * 0.07 * env * (i === 1 ? -1 : 1); dr = 0.08 * env * S(p * Math.PI * 2); return [x + dx, y - 0.05 * env, r * (1 + dr)]; }
        return [x + dx, y + k.poke * 0.02, r * (1 + dr - k.poke * 0.03)];        // ears settle back a touch on a poke          // twitch; ears flatten on a poke
      }) },
    lemon: { c: [[0,0,0.84],[0,-0.72,0.3],[0,0.72,0.3]], sphereR: 0.84, surf: { rx: 0.84, ry: 0.98 }, main: 0, head: 0.4, k: 50, d: 13,
      anim: (c, k) => c.map(([x, y, r], i) => i === 0 ? [x, y, r] : [x + S(k.t * PI2 / 3.1) * 0.012, y + (i === 1 ? -1 : 1) * k.poke * 0.018, r]) },
    ghost: { c: [[0,-0.12,0.84],[-0.48,0.62,0.3],[0,0.7,0.3],[0.48,0.62,0.3]], sphereR: 0.84, surf: { cy: -0.12 }, main: 0, head: 0.32, k: 30, d: 10,
      anim: (c, k) => c.map(([x, y, r], i) => {
        if (i === 0) return [x, y, r];
        const amp = 0.025 + Math.min(0.03, Math.abs(k.vel) / 2500);                   // tail waves; harder when the head moves
        return [x, y + S(k.t * PI2 / 1.7 + i * 1.2) * amp + k.poke * 0.012, r * (1 + k.poke * 0.02)];
      }) },
    cloud: { c: [[0,0,0.94,0.5,-45],[0,0,0.94,0.5,45]], sphereR: 0.86, fitTarget: 0.86, main: -1, head: 0.3, k: 40, d: 12,   // two pills crossed; the X tilts with the head
      anim: (c, k) => c.map(([x, y, rx, ry, a], i) => {
        const b = S(k.t * PI2 / 2.8 + i * Math.PI) * 0.015, puff = k.poke * 0.03;
        return [x, y, rx * (1 + b + puff), ry * (1 + puff - b), a + k.hy * 0.35 + (i ? 1 : -1) * k.hp * 0.15];
      }) },
    drop:  { c: [[0,0.12,0.84],[0,-0.7,0.26]], sphereR: 0.84, surf: { cy: 0.12 }, main: 0, head: 0.45, k: 45, d: 7,        // slightly under-damped: the sprout settles with one soft overshoot
      anim: (c, k) => c.map(([x, y, r], i) => i === 0 ? [x, y, r] : [x, y - k.poke * 0.02, r * (1 + k.poke * 0.04)]) },
    stack: { c: [[0,0,0.55],[0,-0.36,0.86,0.52],[0,0.36,0.86,0.52]], sphereR: 0.84, surf: { rx: 0.9, ry: 0.8 }, main: 0, head: 0.3, k: 40, d: 12,   // hidden core; both ellipses turn with the head
      // the half on the side it looks toward leads; the other half follows on the slow spring
      lag: (i, k) => { const w = Math.max(-1, Math.min(1, k.pitch / 12)); return i === 1 ? Math.max(0, w) : Math.max(0, -w); },
      anim: (c, k) => c.map((p, i) => i === 0 ? p : [p[0], p[1] + S(k.t * PI2 / 3.4 + i * Math.PI) * 0.006, p[2], p[3] * (1 + k.poke * 0.03)]) },
    seacow: { c: [[0,-0.06,0.86],[-0.62,0.6,0.32],[0.62,0.6,0.32]], sphereR: 0.86, surf: { cy: -0.06 }, main: 0, head: 0.35, k: 60, d: 14,   // like the bear, flipped: feet at the bottom corners
      anim: (c, k) => c.map(([x, y, r], i) => i === 0 ? [x, y, r] : [x + S(k.t * PI2 / 2.9 + i * 2) * 0.006, y - k.poke * 0.02, r * (1 - k.poke * 0.03)]) },
    flower: { c: [[0,0,0.8], ...Array.from({ length: 8 }, (_, i) => { const a = i * Math.PI / 4 + Math.PI / 8; return [0.62 * Math.cos(a), 0.62 * Math.sin(a), 0.33]; })], sphereR: 0.86, main: 0, head: 0.25, k: 40, d: 12,
      anim: (c, k) => c.map(([x, y, r], i) => i === 0 ? [x, y, r] : [x, y, r * (1 + S(k.t * PI2 / 3 + i * 0.8) * 0.02 + k.poke * 0.03)]) },   // petals breathe in a ripple
  };
  // ---------- acts: scripted performances layered on top of the normal behaviour ----------
  // run(t, A, ctx): t in seconds; set A.rot/dx/dy/sx/sy (body, pivotY in R units, 1 = bottom edge),
  // A.pieces (fn over normalised pieces before head projection), A.eyeScale/eyeSquash/eyeShake, A.look [yaw, pitch]
  const clamp01 = v => Math.max(0, Math.min(1, v));
  const seg = (t, a, b) => clamp01((t - a) / (b - a));
  const E = {
    io: t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
    o: t => 1 - Math.pow(1 - t, 3),
    i: t => t * t * t,
    back: t => { const c = 1.70158, c3 = c + 1; return 1 + c3 * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); },
    spring: t => 1 - Math.exp(-6 * t) * Math.cos(11 * t),
  };
  // spring from 0 to 1 that starts at rest (zero velocity), overshoots slightly and settles: a = damping, w = frequency
  const spr0 = (u, a, w) => 1 - Math.exp(-a * u) * (Math.cos(w * u) + (a / w) * Math.sin(w * u));
  const rotP = (p, deg) => { const a = deg * D2R, c = Math.cos(a), sn = Math.sin(a), q = p.slice(); q[0] = p[0] * c - p[1] * sn; q[1] = p[0] * sn + p[1] * c; if (q.length > 3) q[4] = (p[4] || 0) + deg; return q; };
  const pulse = (t, a, b) => S(Math.PI * seg(t, a, b));                                  // 0 -> 1 -> 0 across [a, b]
  // press the body against a floor: pieces whose bottom passes the floor line flatten and spread (normalised units)
  const restBottom = cs => Math.max(...cs.map(p => p[1] + (p.length > 3 ? p[3] : p[2])));
  const squashFloor = (cs, depth) => {
    if (depth <= 0) return cs; const floor = restBottom(cs) - depth;
    return cs.map(p => { const ry = p.length > 3 ? p[3] : p[2], rx = p[2], over = p[1] + ry - floor; if (over <= 0) return p;
      return [p[0], p[1] - over * 0.55, rx + over * 0.6, ry - over * 0.55, p.length > 3 ? p[4] : 0]; });
  };
  // hop: soft crouch, arc, gentle landing (floor deformation optional), small settle
  const hop = (t, A, n, P, h, useFloor) => {
    if (t >= n * P) return; const u = (t % P) / P;
    if (u < 0.2) { const c = E.io(u / 0.2); A.sy = 1 - 0.06 * c; A.sx = 1 + 0.03 * c; A.mouthCurve = 0.2 + 0.3 * c; return; }
    if (u < 0.66) { const f = (u - 0.2) / 0.46; A.dy = -h * S(Math.PI * f); const c = 1 - E.o(Math.min(1, f * 3)); A.sy = 1 - 0.06 * c; A.sx = 1 + 0.03 * c; A.mouthCurve = 0.5 + 0.5 * S(Math.PI * f); A.mouthLen = 1 + 0.25 * S(Math.PI * f); return; }
    if (u < 0.82) { const c = S(Math.PI * (u - 0.66) / 0.16); if (useFloor) A.floor = 0.1 * c; else A.sy = 1 - 0.07 * c; A.sx = 1 + 0.05 * c; A.mouthCurve = 0.5 - 0.3 * c; return; }
    const w = (u - 0.82) / 0.18; A.sy = 1 + 0.02 * S(w * Math.PI) ;
  };

  const ACTS = {
    bear: {
      regrow: { label: 'New ears', hint: 'Pulls its ears up and off, they fade away, then fresh ones grow back out of the head.', dur: 3.25,
        run: (t, A) => { const b = pulse(t, 0, 0.4); A.eyeScale = 1 + 0.2 * b;
          const up = E.i(seg(t, 0.4, 1.4)), grow = t < 1.9 ? 0 : E.back(seg(t, 1.9, 3.1));
          A.eyeSquash = 1 - 0.3 * pulse(t, 0.4, 1.4);
          A.pieces = cs => cs.map((p, i) => { if (!i) return p; if (t < 1.9) return [p[0] * (1 + 0.15 * up), p[1] - 0.5 * up, p[2] * (1 - up)]; return [p[0] * (0.7 + 0.3 * grow), -0.3 + (p[1] + 0.3) * grow, p[2] * Math.max(0, grow)]; });
          A.mouthCurve = t < 1.9 ? 0.4 - 0.9 * pulse(t, 0.3, 1.5) : 0.4 + 0.6 * Math.min(1, grow); A.mouthLen = t < 1.9 ? 1 - 0.25 * pulse(t, 0.3, 1.5) : 1 + 0.25 * Math.min(1, grow);
          if (t >= 1.9) A.sy = 1 - 0.04 * pulse(t, 1.9, 2.5); } },
    },
    lemon: {
      bell: { label: 'Bell', hint: 'Swings from its top nub like an old alarm-clock bell, ringing down to rest.', dur: 3.0,
        run: (t, A) => { const e = Math.exp(-t / 1.1); A.rot = 18 * S(PI2 * t / 0.85) * e; A.pivotY = -0.98;
          const lag = 0.05 * S(PI2 * t / 0.85 - 1.2) * e; A.pieces = cs => cs.map((p, i) => i === 2 ? [p[0] + lag, p[1], p[2]] : p);
          A.mouthCurve = 0.5 + 0.4 * e; A.mouthTilt = -0.35 * A.rot; } },
      propeller: { label: 'Propeller', hint: 'Eyes bump, then the nubs orbit the core two full turns; the body shrinks with the speed of the spin.', dur: 2.9,
        run: (t, A) => { const b = pulse(t, 0, 0.45); A.eyeScale = 1 + 0.3 * b; A.eyeSquash = 1 - 0.15 * b;
          const u = seg(t, 0.45, 2.75), th = 720 * E.io(u);
          const speed = (u < 0.5 ? 12 * u * u : 12 * (1 - u) * (1 - u)) / 3;                       // normalised angular speed of the ease
          A.pieces = cs => cs.map((p, i) => i ? rotP(p, th) : p);
          A.sx = A.sy = 1 - 0.14 * speed; A.pivotY = 0; A.eyeSquash *= 1 - 0.4 * speed;
          A.mouthCurve = t < 0.45 ? 0.2 : 0.05 + (1 - speed) * (u >= 1 ? 0.95 : 0.2); A.mouthLen = u >= 1 ? 1.2 : 1 - 0.35 * speed; } },
    },
    ghost: {
      tuck: { label: 'Tuck in', hint: 'Draws its tail up into the body, the skirt flattens while it holds, then the bumps snap back out.', dur: 2.5,
        run: (t, A) => {
          const sOf = d => { const tt = t - d; return tt < 0.9 ? E.io(seg(tt, 0, 0.9)) : tt < 1.5 ? 1 : 1 - E.back(seg(tt, 1.5, 2.3)); };
          const sMid = sOf(0), delay = [0, 0.08, 0, 0.08];
          A.pieces = cs => cs.map((p, i) => { if (!i) return p; const sv = sOf(delay[i]), sp = Math.max(0, sv); return [p[0] * (1 - 0.3 * sp), p[1] - 0.55 * sv, p[2] * (1 - 0.45 * sp)]; });
          const held = Math.max(0, sMid); A.sy = 1 - 0.07 * held; A.sx = 1 + 0.05 * held; A.eyeSquash = 1 - 0.35 * held;
          A.mouthCurve = 0.4 - 0.9 * held + (t > 1.5 ? 0.6 * pulse(t, 1.5, 2.5) : 0); } },
      piano: { label: 'Piano', hint: 'Presses its tail bumps one after another like piano keys; the idle keys shrink and lean away.', dur: 3.3,
        run: (t, A) => { const order = [1, 2, 3, 2, 1, 2, 3, 3, 2], step = 0.36, k = Math.min(order.length - 1, Math.floor(t / step)), u = (t % step) / step, pr = t < order.length * step ? S(Math.PI * u) : 0, key = order[k];
          A.pieces = cs => { const kx = cs[key][0]; return cs.map((p, i) => { if (!i) return p; if (i === key) return [p[0], p[1] + 0.09 * pr, p[2] * (1 - 0.12 * pr)]; const away = Math.sign(p[0] - kx) || (i < key ? -1 : 1); return [p[0] + away * 0.06 * pr, p[1] - 0.03 * pr, p[2] * (1 - 0.15 * pr)]; }); };
          A.look = [0, -14]; A.dy = 1.5 * pr; A.mouthCurve = 0.5 + 0.35 * pr; A.mouthLen = 0.7 + 0.2 * pr; A.mouthTilt = (key - 2) * 7 * pr; } },
    },
    cloud: {
      quarter: { label: 'Quarter turns', hint: 'Turns a full circle in four springy 90 degree steps; the eyes start to follow each turn and swing back.', dur: 3.5,
        run: (t, A) => { const step = 0.85, k = Math.min(3, Math.floor(t / step)), u = seg(t, k * step, k * step + 0.62), th = t >= 4 * step ? 360 : 90 * k + 90 * E.back(u);
          A.pieces = cs => cs.map(p => p.length > 3 ? [p[0], p[1], p[2], p[3], (p[4] || 0) + th] : p); A.dy = -3 * S(Math.PI * u);
          A.eyeOrbit = 14 * S(Math.PI * Math.min(1, u * 1.3)); A.mouthCurve = t >= 4 * step ? 0.9 : 0.1; A.mouthLen = t >= 4 * step ? 1.2 : 0.75; } },
      hop: { label: 'Hop', hint: 'Two soft hops with a small squash on landing.', dur: 2.05, run: (t, A) => hop(t, A, 2, 1.0, 20, false) },
    },
    drop: {
      hop: { label: 'Hop', hint: 'Two soft hops with a small squash on landing.', dur: 2.05, run: (t, A) => hop(t, A, 2, 1.0, 22, false) },
      sprout: { label: 'New sprout', hint: 'Eyes bump, the body tightens as the sprout pulls free and fades, then a new one grows out of it.', dur: 3.1,
        run: (t, A) => { const b = pulse(t, 0, 0.4); A.eyeScale = 1 + 0.25 * b;
          const up = E.i(seg(t, 0.4, 1.3)), grow = t < 1.8 ? 0 : E.back(seg(t, 1.8, 2.9)), pull = pulse(t, 0.4, 1.3);
          A.eyeSquash = 1 - 0.3 * pull; A.sx = A.sy = 1 - 0.08 * pull; A.pivotY = 0;
          A.pieces = cs => cs.map((p, i) => { if (!i) return p; if (t < 1.8) return [p[0], p[1] - 0.6 * up, p[2] * (1 - up)]; return [p[0], -0.35 + (p[1] + 0.35) * grow, p[2] * Math.max(0, grow)]; });
          A.mouthCurve = t < 1.8 ? 0.4 - 0.9 * pull : 0.4 + 0.6 * Math.min(1, grow); A.mouthLen = t < 1.8 ? 1 - 0.25 * pull : 1 + 0.25 * Math.min(1, grow);
          if (t >= 1.8) A.sy *= 1 - 0.04 * pulse(t, 1.8, 2.4); } },
    },
    stack: {
      deflate: { label: 'Deflate', hint: 'Squeezes toward its centre with a soft spring, holds, then springs back.', dur: 3.0,
        run: (t, A) => { const sv = t < 1.1 ? E.back(E.io(seg(t, 0, 1.1))) : t < 1.6 ? 1 : 1 - E.spring(seg(t, 1.6, 2.9)); const sp = Math.max(0, sv);
          A.pieces = cs => cs.map((p, i) => i === 0 ? p : [p[0], p[1] * (1 - 0.42 * sv), p[2] * (1 + 0.1 * sp), p[3] * (1 - 0.28 * sp)]);
          A.eyeScale = 1 - 0.2 * sp; A.eyeSquash = 1 - 0.25 * sp; A.mouthCurve = 0.4 - 1.1 * sp; A.mouthLen = 1 - 0.3 * sp; } },
      stretch: { label: 'Stretch', hint: 'A slow blink, then the halves pull apart with the eyes stretching too, hold, and snap back together.', dur: 3.2,
        run: (t, A) => { A.eyeSquash = 1 - 0.35 * pulse(t, 0, 0.7);
          const u = t < 0.7 ? 0 : t < 1.7 ? E.io(seg(t, 0.7, 1.7)) : t < 2.3 ? 1 : 1 - E.spring(seg(t, 2.3, 3.2));
          A.pieces = cs => cs.map((p, i) => i === 0 ? [p[0], p[1], p[2] * (1 + 0.1 * u), p[2] * (1 + 0.1 * u) + 0.26 * u, 0] : i === 1 ? [p[0], p[1] - 0.24 * u, p[2], p[3]] : [p[0], p[1] + 0.24 * u, p[2], p[3]]);   // the core grows into a waist
          A.eyeSquash *= 1 + 0.4 * u; A.eyeScale = 1 + 0.05 * u; A.mouthCurve = 0.4 - 0.6 * u + (t > 2.3 ? 0.5 * pulse(t, 2.3, 3.0) : 0); A.mouthLen = 1 - 0.55 * u; } },
    },
    seacow: {
      wave: { label: 'Wave', hint: 'Lifts and waves the left flipper, then the right, glancing at each.', dur: 3.1,
        run: (t, A) => { const side = t < 1.55 ? 1 : 2, u = side === 1 ? seg(t, 0.1, 1.5) : seg(t, 1.6, 3.0), lift = S(Math.PI * u), wig = S(PI2 * u * 3) * 0.06 * lift;
          A.pieces = cs => cs.map((p, i) => i === side ? [p[0] + (side === 1 ? -0.12 : 0.12) * lift + wig, p[1] - 0.55 * lift, p[2]] : p);
          A.look = [side === 1 ? -18 : 18, 8]; A.rot = (side === 1 ? -4 : 4) * lift; A.mouthCurve = 0.5 + 0.5 * lift; A.mouthSide = (side === 1 ? -1 : 1) * lift; A.mouthLen = 1 + 0.15 * lift; A.mouthTilt = (side === 1 ? 10 : -10) * lift; } },
      cover: { label: 'Cover eyes', hint: 'Each flipper travels up its own side of the body and in over the eye, holds, then goes back down the same way.', dur: 3.25,
        run: (t, A, ctx) => {
          const o = ctx.self.o, su = ctx.self._surf, ex = Math.sin(o.eyeLon * D2R) * su.rx, ey = su.cy - Math.sin(o.eyeLat * D2R) * su.ry;
          const u = t < 1.0 ? E.io(seg(t, 0, 1.0)) : t < 2.1 ? 1 : 1 - E.io(seg(t, 2.1, 3.2));               // 0 at rest, 1 covering
          const path = (side, k) => {                                                              // corner -> up the side -> in over the eye
            const x0 = side * 0.62, y0 = 0.6, x1 = side * 0.7, y1 = 0.02, x2 = side * ex, y2 = ey;
            if (k < 0.55) { const a = E.io(k / 0.55); return [x0 + (x1 - x0) * a, y0 + (y1 - y0) * a]; }
            const a = E.io((k - 0.55) / 0.45); return [x1 + (x2 - x1) * a, y1 + (y2 - y1) * a]; };
          const L = path(-1, u), R = path(1, u), r = 0.32 - 0.06 * u;
          A.pieces = cs => cs.map((p, i) => i === 1 ? [L[0], L[1], r] : i === 2 ? [R[0], R[1], r] : p);
          if (u > 0) A.overlay = [[L[0], L[1], r], [R[0], R[1], r]];
          A.look = [0, 0]; A.mouthCurve = 0.4 - 0.4 * u + (t > 2.8 ? 0.5 * pulse(t, 2.8, 3.4) : 0); } },
    },
    flower: {
      // both acts run off one master value so rotation, fillet, petals and eyes always move together
      spin: { label: 'Spin', hint: 'Eyes merge into one circle, a springy half turn with sharper petals, eyes part as it settles. One curve drives it all.', dur: 2.8,
        run: (t, A) => { const u = seg(t, 0, 2.7), k = spr0(u, 4.5, 6);                                       // master: starts at rest, springy 0 -> 1 with a slight overshoot
          const kc = clamp01(k), ss = x => x * x * x * (x * (x * 6 - 15) + 10), m = Math.min(ss(clamp01(kc / 0.5)), 1 - ss(clamp01((kc - 0.65) / 0.35)));   // eyes glide together over the first half of the turn, hold, and part over the last third; quintic edges
          A.pieces = cs => cs.map((p, i) => i ? rotP(p, 180 * k) : p);
          A.roundMul = 1 - 0.6 * m; A.eyeMerge = m; A.eyeScale = 1 + 0.6 * m; A.mouthTrim = 1 - m; A.mouthCurve = 0.4 + 0.6 * (1 - m) * clamp01((kc - 0.6) / 0.4); } },
      inflate: { label: 'Inflate', hint: 'Swells into one big circle with a soft spring, holds, then shrinks past its size and springs back. One curve drives it all.', dur: 3.15,
        run: (t, A) => { const p = t < 1.0 ? spr0(seg(t, 0, 1.0), 5, 5.5) : t < 1.5 ? 1 : 1 - spr0(seg(t, 1.5, 3.1), 4, 6.5);   // master: in at rest, hold, spring out through an undershoot
          A.pieces = cs => cs.map((p2, i) => i ? [p2[0], p2[1], p2[2] * (1 + 0.1 * p)] : [p2[0], p2[1], p2[2] * (1 + 0.22 * p)]);
          A.eyeScale = 1 + 0.3 * p; A.mouthCurve = 0.4 + 0.6 * Math.max(0, p); A.mouthLen = 1 + 0.35 * Math.max(0, p); } },
    },
  };
  for (const k in ACTS) if (COMPOSED[k]) COMPOSED[k].acts = ACTS[k];
  // visual balance: scale every composed body so its rest silhouette reaches the same extent (in R units)
  const FIT_TARGET = 0.95;
  const extentOf = cs => Math.max(...cs.map(p => {
    if (p.length > 3) { const a = (p[4] || 0) * D2R, c = Math.cos(a), sn = Math.sin(a), ex = Math.hypot(p[2] * c, p[3] * sn), ey = Math.hypot(p[2] * sn, p[3] * c); return Math.max(Math.abs(p[0]) + ex, Math.abs(p[1]) + ey); }
    return Math.max(Math.abs(p[0]), Math.abs(p[1])) + p[2];
  }));
  const fitOf = comp => { if (comp._fit == null) comp._fit = (comp.fitTarget || FIT_TARGET) / extentOf(comp.c); return comp._fit; };

  // Generative blob bodies: a seed produces a whole body definition (pieces, spring, idle motion, lag rule)
  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  // complexity 0..1: low = one or two mirrored circles, high = up to five pieces, ellipses, asymmetry
  function blobBody(seed, opts = {}) {
    const cx = Math.max(0, Math.min(1, opts.complexity == null ? 0.5 : opts.complexity));
    const R = mulberry32((seed | 0) * 9973 + 17), rnd = (a, b) => a + (b - a) * R(), pick = arr => arr[Math.floor(R() * arr.length)];
    const mainR = rnd(0.74, 0.9), c = [[0, rnd(-0.08, 0.08), mainR]];
    const n = 1 + Math.floor(R() * (1 + cx * 4)), mirror = R() < 0.95 - cx * 0.7; let ellipses = 0;
    for (let i = 0; i < n; i++) {
      const ang = rnd(-Math.PI, Math.PI), r = rnd(0.22, 0.3 + cx * 0.12), ell = R() < cx * 0.6;
      const dist = Math.max(rnd(0.55, 0.8), mainR - r + 0.16);                        // always pokes clearly out of the core
      const x = Math.cos(ang) * dist, y = Math.sin(ang) * dist;
      const piece = ell ? [x, y, r * rnd(1.1, 1.6), r * rnd(0.5, 0.85), rnd(-60, 60)] : [x, y, r];
      if (ell) ellipses++;
      c.push(piece);
      if (mirror && Math.abs(x) > 0.12) { const m = piece.slice(); m[0] = -x; if (m.length > 3) m[4] = -m[4]; c.push(m); }
    }
    const head = rnd(0.22, 0.45), k = rnd(30, 75), bouncy = R() < 0.25, d = bouncy ? rnd(5, 8) : rnd(10, 15);
    const phase = c.map(() => R() * PI2), speed = rnd(2.2, 3.8), amp = rnd(0.01, 0.03), lagMode = R() < 0.35;
    const temperament = pick(['calm', 'curious', 'sleepy', 'jumpy']);
    const traits = [
      `${c.length - 1} piece${c.length > 2 ? 's' : ''} on a ${mainR.toFixed(2)}R core` + (ellipses ? `, ${ellipses} of them elliptical` : ''),
      mirror ? 'mirrored left and right' : 'asymmetric',
      bouncy ? 'under-damped spring, pieces overshoot and settle' : 'well-damped spring, pieces glide',
      lagMode ? 'the side it looks away from trails the turn' : 'all pieces turn together',
      `breathes every ${speed.toFixed(1)} s at ${(amp * 100).toFixed(0)}% of piece size`,
    ];
    return {
      name: 'blob-' + seed, seed, complexity: cx, c, sphereR: mainR, main: 0, head, k, d, temperament, traits,
      anim: (cs, kk) => cs.map((p, i) => {
        if (i === 0) return p;
        const b = 1 + S(kk.t * PI2 / speed + phase[i]) * amp;
        return p.length > 3 ? [p[0], p[1], p[2] * b, p[3] * (1 + kk.poke * 0.03), p[4]] : [p[0], p[1], p[2] * (b + kk.poke * 0.03)];
      }),
      lag: lagMode ? (i, kk) => { const w = Math.max(-1, Math.min(1, kk.yaw / 15)); return c[i][0] > 0 ? Math.max(0, -w) : Math.max(0, w); } : null,
    };
  }
  // project a rest-position piece onto the head sphere and rotate it by the head angles (degrees)
  function headProject(c, hy, hp) {
    const [x, y, r] = c, d2 = x * x + y * y, z0 = Math.sqrt(Math.max(0.02, 1 - d2));
    const v = rotv([x, -y, z0], hy * D2R, hp * D2R);
    const depth = z => z >= 0 ? 0.85 + 0.15 * z : 0.85 * Math.max(0, 1 + z / 0.6);      // near pieces read larger; behind the head they shrink away
    const sc = depth(v[2]) / depth(z0);
    return c.length > 3 ? [v[0], -v[1], r * sc, c[3] * sc, c[4] || 0] : [v[0], -v[1], r * sc];
  }
  function rotv(v, y, p) {
    const cy = Math.cos(y), sy = Math.sin(y), cp = Math.cos(p), sp = Math.sin(p);
    const x = v[0] * cy + v[2] * sy, z = -v[0] * sy + v[2] * cy;
    return [x, v[1] * cp + z * sp, -v[1] * sp + z * cp];
  }
  function polar(fn, n = 96) { let d=''; for (let i=0;i<n;i++){ const [x,y]=fn(i/n*Math.PI*2); d+=(i?'L':'M')+(100+x).toFixed(2)+' '+(100+y).toFixed(2); } return d+'Z'; }
  const EYES = { round:{eyeW:22,eyeH:22,corner:1}, pill:{eyeW:18,eyeH:30,corner:1}, square:{eyeW:22,eyeH:22,corner:0.35}, wide:{eyeW:28,eyeH:18,corner:1}, tall:{eyeW:14,eyeH:34,corner:1} };

  const PRESETS = {
    hero: {},
    avatar: { follow: false, idle: false, lean: false, breathe: false, tap: false, shade: 'flat' },   // calm in a list; blinking stays
  };
  class Mascot {
    constructor(svg, opts = {}) {
      this.svg = svg;
      this.o = Object.assign({
        preset: 'hero',     // 'hero' (default) | 'avatar': small, calm, no cursor tricks; see PRESETS
        tap: true,          // poke on pointerdown
        radius: 96,      // sphere radius in viewBox units (centre 100,100; viewBox -24 -24 248 248 leaves room for ears and puffs)
        eyeLon: 16,      // degrees each eye sits from the centre meridian
        eyeLat: 4,       // degrees above the equator
        eyeW: 22,        // eye width  (viewBox units)
        eyeH: 22,        // eye height (viewBox units)
        corner: 1,       // 0 = square, 1 = fully rounded
        body: 'circle',  // circle | squircle | egg | pebble | bear | lemon | ghost | cloud | drop | stack | seacow | flower | array of [x,y,r] or [x,y,rx,ry,angle]
        round: 0.5,      // fillet amount for composed bodies, 0..1
        eye: null,       // preset name: round | pill | square | wide | tall (overrides eyeW/eyeH/corner)
        maxYaw: 20, maxPitch: 15,
        shaded: true, wireframe: false, lean: true, breathe: true,
        follow: true, idle: true, autoBlink: true,
        color: '#0a0a0a',   // body colour, or an array of two hex colours for a custom gradient mapped on the head sphere
        gradientAngle: 90,  // custom gradient runs top to bottom (internal; not part of the public options)
        shade: 'flat',      // flat | gradient | soft | glossy | rim   (gradient: a lighter tint on the front of the sphere that moves with the gaze)
        light: -135,        // direction the light comes from, degrees: 0 right, -90 top, -135 top-left
        contrast: 1,        // shading strength multiplier
        eyeColor: null,     // null = auto (white on dark bodies, ink on light ones)
        mouth: true,        // draw a mouth: a stroked arc on the eye sphere below the eyes
        mouthCurve: 0.4,    // -1 frown .. 0 flat .. 1 smile
        mouthWidth: 1,      // relative width
        mouthStroke: 6,     // stroke width (viewBox units, about 1px at a 240px render)
        mouthDrop: 22,      // degrees below the eye line
        twitch: false,      // bear only: occasional single ear wiggle
        fit: true,          // scale composed bodies to a common visual extent
      }, PRESETS[opts.preset] || {}, opts);
      this._status = 'idle';
      // live values
      this.yaw = 0; this.pitch = 0; this.tYaw = 0; this.tPitch = 0;
      this.blinkAmt = 0; this.eyeScale = 1; this.squash = 1; this.mouth = null; this.tMouth = null;   // null = follow o.mouthCurve
      this.mouthSide = 0; this.tMouthSide = 0; this.mouthLen = 1; this.tMouthLen = 1; this.mouthTilt = 0; this.tMouthTilt = 0;   // animatable smirk, length and tilt outside acts
      this.tEyeScale = 1; this.tSquash = 1;
      this.manual = false;
      this._poke = 0; this._pokeS = 0; this._vel = 0; this._twitch = null; this._t = 0; this._dt = 0; this._mem = {};
      this._hy = 0; this._hp = 0; this._hvy = 0; this._hvp = 0;   // head angles + spring velocities
      this._sy = 0; this._sp = 0; this._svy = 0; this._svp = 0;   // slow head spring (for lagging pieces)
      svg.__mascot = this;   // handy for inspection and wrappers
      this._build(); this.render();
    }

    _build() {
      const id = 'orb' + (uid++);
      const s = this.svg; s.setAttribute('viewBox', '-24 -24 248 248'); s.innerHTML = '';
      const defs = el('defs', {});
      const g = el('radialGradient', { id: id + 'g', gradientUnits: 'userSpaceOnUse', cx: 72, cy: 62, r: 165 });
      this.stops = [el('stop', { offset: '0' }), el('stop', { offset: '0.45' }), el('stop', { offset: '1' })];
      g.append(...this.stops); this.grad = g;
      this.specGrad = el('radialGradient', { id: id + 's', gradientUnits: 'userSpaceOnUse' });
      this.specGrad.append(el('stop', { offset: '0', 'stop-color': '#fff', 'stop-opacity': '0.5' }), el('stop', { offset: '1', 'stop-color': '#fff', 'stop-opacity': '0' }));
      this.rimGrad = el('radialGradient', { id: id + 'r', gradientUnits: 'userSpaceOnUse' });
      this.rimGrad.append(el('stop', { offset: '0', 'stop-color': '#fff', 'stop-opacity': '0' }), el('stop', { offset: '0.62', 'stop-color': '#fff', 'stop-opacity': '0' }), el('stop', { offset: '1', 'stop-color': '#fff', 'stop-opacity': '0.3' }));
      this.lin = el('linearGradient', { id: id + 'l', gradientUnits: 'userSpaceOnUse' });
      this.linStops = [el('stop', { offset: '0' }), el('stop', { offset: '1' })]; this.lin.append(...this.linStops);
      // shader = two separate layers over the flat colour: a white light (centre to 0.65) and a black shadow (0.65 to the rim); each fades to its own colour, so no mid tint is needed
      // shader: two layers in the body's own colours (lighter / darker, OKLab), each a linear gradient on the body's axis, faded by a radial alpha mask that follows the gaze
      this.lightLin = el('linearGradient', { id: id + 'tl', gradientUnits: 'userSpaceOnUse' }); this.lightLin.append(el('stop', { offset: '0' }), el('stop', { offset: '1' }));
      this.shadowLin = el('linearGradient', { id: id + 'ts', gradientUnits: 'userSpaceOnUse' }); this.shadowLin.append(el('stop', { offset: '0' }), el('stop', { offset: '1' }));
      this.lightGrad = el('radialGradient', { id: id + 'ta', gradientUnits: 'userSpaceOnUse' });
      this.lightGrad.append(el('stop', { offset: '0', 'stop-color': '#fff', 'stop-opacity': '1' }), el('stop', { offset: '0.65', 'stop-color': '#fff', 'stop-opacity': '0' }));
      this.shadowGrad = el('radialGradient', { id: id + 'sa', gradientUnits: 'userSpaceOnUse' });
      this.shadowGrad.append(el('stop', { offset: '0.65', 'stop-color': '#fff', 'stop-opacity': '0' }), el('stop', { offset: '1', 'stop-color': '#fff', 'stop-opacity': '1' }));
      const maskL = el('mask', { id: id + 'ml' }), maskS = el('mask', { id: id + 'ms' });
      maskL.append(el('rect', { x: -40, y: -40, width: 280, height: 280, fill: `url(#${id}ta)` })); maskS.append(el('rect', { x: -40, y: -40, width: 280, height: 280, fill: `url(#${id}sa)` }));
      defs.append(this.specGrad, this.rimGrad, this.lin, this.lightLin, this.shadowLin, this.lightGrad, this.shadowGrad, maskL, maskS); this.specId = id + 's'; this.rimId = id + 'r'; this.linId = id + 'l';
      this.lightEl = el('g', { mask: `url(#${id}ml)` }); this.lightEl.append(el('rect', { x: -40, y: -40, width: 280, height: 280, fill: `url(#${id}tl)`, mask: `url(#${id}c)` }));
      this.shadowEl = el('g', { mask: `url(#${id}ms)` }); this.shadowEl.append(el('rect', { x: -40, y: -40, width: 280, height: 280, fill: `url(#${id}ts)`, mask: `url(#${id}c)` }));
      this.blur = el('feGaussianBlur', { stdDeviation: 7, result: 'b' });
      const goo = el('filter', { id: id + 'f', x: '-20%', y: '-20%', width: '140%', height: '140%' });
      goo.append(this.blur, el('feColorMatrix', { in: 'b', type: 'matrix', values: '1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 24 -11' }));
      const mask = el('mask', { id: id + 'c' });
      this.clipCircle = el('path', { fill: '#fff' });
      this.maskGoo = el('g', { fill: '#fff', filter: `url(#${id}f)` });
      mask.append(this.clipCircle, this.maskGoo);
      defs.append(g, goo, mask); s.append(defs);
      this.gooId = id + 'f';

      this.root = el('g', {});                  // breathing
      this.body = el('g', {});                  // lean
      this.sphere = el('path', {});
      this.goo = el('g', { filter: `url(#${id}f)` });
      this.gradId = id + 'g';
      this.face = el('g', { mask: `url(#${id}c)` });
      this.wire = el('path', { fill: 'none', stroke: 'rgba(255,255,255,0.22)', 'stroke-width': 0.6 });
      this.eyeL = el('rect', {});
      this.eyeR = el('rect', {});
      this.starL = el('path', {}); this.starR = el('path', {});   // star-shaped eyes for the surprised morph
      this.rimEl = el('rect', { x: -40, y: -40, width: 280, height: 280, fill: `url(#${id}r)` });
      this.spec = el('ellipse', { fill: `url(#${id}s)` });
      this.over = el('g', {});
      this.mouthEl = el('path', { fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
      this.face.append(this.rimEl, this.spec, this.wire, this.eyeL, this.eyeR, this.starL, this.starR, this.mouthEl, this.over);
      this.body.append(this.sphere, this.goo, this.shadowEl, this.lightEl, this.face);   // shadow first, light on top
      this.root.append(this.body); s.append(this.root);
    }

    // rotate a unit vector: yaw about Y (right +), then pitch about X (up +)
    _rot(v) {
      const y = this.yaw * D2R, p = this.pitch * D2R;
      const cy = Math.cos(y), sy = Math.sin(y), cp = Math.cos(p), sp = Math.sin(p);
      const x = v[0] * cy + v[2] * sy, z = -v[0] * sy + v[2] * cy;
      return [x, v[1] * cp + z * sp, -v[1] * sp + z * cp];
    }

    // tangent-plane frame of a point on the sphere, projected orthographically
    _frame(lonDeg, latDeg) {
      const R = this.o.radius, su = this._surf, lon = lonDeg * D2R, lat = latDeg * D2R;
      const P = this._rot([Math.sin(lon) * Math.cos(lat), Math.sin(lat), Math.cos(lon) * Math.cos(lat)]);
      const E = this._rot([Math.cos(lon), 0, -Math.sin(lon)]);                                  // east
      const N = this._rot([-Math.sin(lon) * Math.sin(lat), Math.cos(lat), -Math.cos(lon) * Math.sin(lat)]); // north
      // the eye surface is a spheroid: radii rx (x, z) and ry (y), centre offset (cx, cy); the eye disc keeps its size
      const avg = (su.rx + su.ry) / 2, kx = su.rx / avg, ky = su.ry / avg;
      return { m: [E[0] * kx, -E[1] * ky, -N[0] * kx, N[1] * ky, 100 + R * (su.cx + su.rx * P[0]), 100 + R * (su.cy - su.ry * P[1])], z: P[2] };
    }

    _eye(rect, side) {
      const o = this.o, A = this._A; let lon = side * o.eyeLon, lat = o.eyeLat, round = false;
      let f = this._frame(lon, lat);
      if (A && (A.eyeOrbit || A.eyeMerge)) {                                                   // spinner / merge: a perfect screen-space circle around the midpoint, eyes stay round
        const fl = this._frame(-o.eyeLon, o.eyeLat), fr = this._frame(o.eyeLon, o.eyeLat);
        const mg = A.eyeMerge || 0, su = this._surf, R = o.radius;
        const cx = (fl.m[4] + fr.m[4]) / 2 * (1 - mg) + (100 + R * su.cx) * mg, cy = (fl.m[5] + fr.m[5]) / 2 * (1 - mg) + (100 + R * su.cy) * mg;   // merged eye settles on the body centre
        const d = Math.hypot(fr.m[4] - fl.m[4], fr.m[5] - fl.m[5]) / 2 * (1 - mg) * (A.orbitScale || 1);
        const th = (A.eyeOrbit || 0) * D2R + (side < 0 ? Math.PI : 0);
        f = { m: [1, 0, 0, 1, cx + d * Math.cos(th), cy + d * Math.sin(th)], z: 1 }; round = true;
      }
      const w = o.eyeW, h = o.eyeH, rx = Math.min(w, h) / 2 * o.corner;
      const open = 1 - this.blinkAmt * 0.94;
      const sx = this.eyeScale * (A ? A.eyeScale : 1), sy = round ? sx : this.eyeScale * this.squash * open * (A ? A.eyeSquash : 1);
      const jx = A && A.eyeShake ? (Math.random() * 2 - 1) * A.eyeShake : 0, jy = A && A.eyeShake ? (Math.random() * 2 - 1) * A.eyeShake : 0;
      rect.setAttribute('x', -w / 2); rect.setAttribute('y', -h / 2);
      rect.setAttribute('width', w); rect.setAttribute('height', h); rect.setAttribute('rx', rx);
      const tf = `translate(${jx.toFixed(2)} ${jy.toFixed(2)}) matrix(${f.m.map(n => n.toFixed(4)).join(' ')}) translate(0 ${(round ? 0 : this.blinkAmt * h * 0.08).toFixed(2)}) scale(${sx.toFixed(3)} ${sy.toFixed(3)})`;
      rect.setAttribute('transform', tf);
      const star = A && A.eyeStar ? A.eyeStar : 0, sp = side < 0 ? this.starL : this.starR;
      if (star > 0.001) {                                                                      // morph: a smoothed 10-point polygon from circle (0) to a five-point star (1)
        const r0 = w / 2, pts = []; for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = r0 * (1 + star * (i % 2 ? -0.55 : 0.28)); pts.push([Math.cos(a) * rr, Math.sin(a) * rr]); }
        const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]; const soft = 1 - 0.85 * star;   // soft corners at 0, sharper tips at 1
        let d = ''; for (let i = 0; i < 10; i++) { const p = pts[i], q = pts[(i + 1) % 10], m = mid(p, q); const c = [p[0] + (m[0] - p[0]) * soft, p[1] + (m[1] - p[1]) * soft]; if (!i) { const m0 = mid(pts[9], pts[0]); d = `M ${m0[0].toFixed(2)} ${m0[1].toFixed(2)} `; } d += `Q ${p[0].toFixed(2)} ${p[1].toFixed(2)} ${m[0].toFixed(2)} ${m[1].toFixed(2)} `; }
        const us = sx * (1 + 0.38 * star);                                                      // stars stay upright and round, scaled up a good deal
        sp.setAttribute('d', d + 'Z'); sp.setAttribute('transform', `translate(${(jx + f.m[4]).toFixed(2)} ${(jy + f.m[5]).toFixed(2)}) scale(${us.toFixed(3)})`);
        sp.style.visibility = f.z > -0.05 ? 'visible' : 'hidden'; rect.style.visibility = 'hidden';
      } else { sp.setAttribute('d', ''); rect.style.visibility = f.z > -0.05 ? 'visible' : 'hidden'; }
      return f.z;
    }

    _mouth(stroke) {
      const o = this.o, A = this._A, el = this.mouthEl;
      const trim = A && A.mouthTrim != null ? A.mouthTrim : 1;
      if (!o.mouth || trim <= 0.01) { el.setAttribute('d', ''); return; }
      const f = this._frame(0, o.eyeLat - o.mouthDrop); if (f.z < -0.05) { el.setAttribute('d', ''); return; }
      const curve = A && A.mouthCurve != null ? A.mouthCurve : (this.mouth == null ? o.mouthCurve : this.mouth);
      const len = A && A.mouthLen != null ? A.mouthLen : this.mouthLen, side = A && A.mouthSide ? A.mouthSide : this.mouthSide;   // side: +1 keeps the right end, trims the left (smirk to the right)
      const tilt = A && A.mouthTilt != null ? A.mouthTilt : this.mouthTilt;                                  // degrees, positive = right end drops
      const hw = 14 * o.mouthWidth * this.eyeScale * (A ? A.eyeScale : 1) * trim * len;
      const hl = hw * (1 - 0.7 * Math.max(0, side)), hr = hw * (1 - 0.7 * Math.max(0, -side));
      const bulge = curve * (hl + hr) / 2 * 1.15, mid = (hr - hl) / 2;                            // positive = smile (bulges down on screen)
      el.setAttribute('d', `M ${(-hl).toFixed(2)} 0 Q ${mid.toFixed(2)} ${bulge.toFixed(2)} ${hr.toFixed(2)} 0`);
      el.setAttribute('stroke', stroke); el.setAttribute('stroke-width', ((o.mouthStroke == null ? 6 : o.mouthStroke) * 1.3 * this.eyeScale * (0.6 + 0.4 * trim)).toFixed(2));
      if (A && A.eyeOrbit) {                                                                   // spinner: the mouth is the third point on the eyes' circle, kept tangent
        const fl = this._frame(-o.eyeLon, o.eyeLat), fr = this._frame(o.eyeLon, o.eyeLat);
        const cx = (fl.m[4] + fr.m[4]) / 2, cy = (fl.m[5] + fr.m[5]) / 2, dm = Math.hypot(f.m[4] - cx, f.m[5] - cy) * (A.orbitScale || 1), th = A.eyeOrbit * D2R + Math.PI / 2;
        el.setAttribute('transform', `translate(${(cx + dm * Math.cos(th)).toFixed(2)} ${(cy + dm * Math.sin(th)).toFixed(2)}) rotate(${(A.eyeOrbit + tilt).toFixed(2)})`);
        return;
      }
      el.setAttribute('transform', `matrix(${f.m.map(n => n.toFixed(4)).join(' ')}) rotate(${tilt.toFixed(2)})`);
    }

    _wireframe() {
      if (!this.o.wireframe) { this.wire.setAttribute('d', ''); return; }
      let d = '';
      const line = pts => { let pen = false; for (const [lon, lat] of pts) { const f = this._frame(lon, lat); if (f.z > 0.01) { d += (pen ? 'L' : 'M') + f.m[4].toFixed(1) + ' ' + f.m[5].toFixed(1); pen = true; } else pen = false; } };
      for (let lon = 0; lon < 180; lon += 30) { const p = []; for (let lat = -90; lat <= 90; lat += 5) p.push([lon, lat]); line(p); }
      for (let lat = -60; lat <= 60; lat += 30) { const p = []; for (let lon = -180; lon <= 180; lon += 5) p.push([lon, lat]); line(p); }
      this.wire.setAttribute('d', d);
    }

    render() {
      const o = this.o;
      if (o.eye && EYES[o.eye]) Object.assign(o, EYES[o.eye]);
      const custom = Array.isArray(o.color);
      const baseHex = custom ? mix(hex2(o.color[0]), hex2(o.color[1]), 0.5) : o.color;      // average colour drives eye contrast
      const style = custom ? 'custom' : o.shaded === false ? 'flat' : (o.shade || 'soft');
      if (custom) {
        this.linStops[0].setAttribute('stop-color', o.color[0]); this.linStops[1].setAttribute('stop-color', o.color[1]);
      }
      const shadeKey = baseHex + '|' + style + '|' + o.light + '|' + o.contrast + '|' + o.radius;
      if (this._shadeKey !== shadeKey) {
        this._shadeKey = shadeKey; const c = hex2(baseHex), W = [255, 255, 255], K = [0, 0, 0], k = o.contrast == null ? 1 : o.contrast, lum0 = lum(c);
        const a = (o.light == null ? -135 : o.light) * D2R, dx = Math.cos(a), dy = Math.sin(a), R = o.radius;
        const glossy = style === 'glossy', grad = style === 'gradient';
        if (grad) { this.stops[0].setAttribute('stop-color', mix(c, W, 0.34 * k)); this.stops[1].setAttribute('stop-color', mix(c, W, 0.06 * k)); this.stops[1].setAttribute('offset', '0.5'); this.stops[2].setAttribute('stop-color', mix(c, K, 0.2 * k)); this.grad.setAttribute('r', (1.35 * R).toFixed(1)); }
        else this.stops[1].setAttribute('offset', '0.45');
        if (!grad) { this.stops[0].setAttribute('stop-color', mix(c, W, (glossy ? 0.34 : 0.24) * k)); this.stops[1].setAttribute('stop-color', mix(c, K, 0.08 * k)); this.stops[2].setAttribute('stop-color', mix(c, K, (glossy ? 0.55 : 0.45) * k));
          this.grad.setAttribute('cx', (100 + dx * 0.45 * R).toFixed(1)); this.grad.setAttribute('cy', (100 + dy * 0.45 * R).toFixed(1)); this.grad.setAttribute('r', (1.7 * R).toFixed(1)); }
        // specular: a soft highlight toward the light (glossy only), fainter on light bodies
        this.spec.style.display = glossy ? '' : 'none';
        if (glossy) { const sx = 100 + dx * 0.5 * R, sy = 100 + dy * 0.5 * R; this.spec.setAttribute('cx', sx.toFixed(1)); this.spec.setAttribute('cy', sy.toFixed(1)); this.spec.setAttribute('rx', (0.34 * R).toFixed(1)); this.spec.setAttribute('ry', (0.22 * R).toFixed(1)); this.spec.setAttribute('transform', `rotate(${(a / D2R + 90).toFixed(1)} ${sx.toFixed(1)} ${sy.toFixed(1)})`); this.specGrad.setAttribute('cx', sx.toFixed(1)); this.specGrad.setAttribute('cy', sy.toFixed(1)); this.specGrad.setAttribute('r', (0.34 * R).toFixed(1)); this.spec.setAttribute('opacity', (lum0 > 0.5 ? 0.35 : 0.7) * k); }
        // rim: a light edge on the side away from the light (rim only)
        this.rimEl.style.display = style === 'rim' ? '' : 'none';
        if (style === 'rim') { this.rimGrad.setAttribute('cx', (100 - dx * 0.35 * R).toFixed(1)); this.rimGrad.setAttribute('cy', (100 - dy * 0.35 * R).toFixed(1)); this.rimGrad.setAttribute('r', (1.25 * R).toFixed(1)); this.rimEl.setAttribute('opacity', (lum0 > 0.5 ? 0.5 : 1) * k); }
      }
      const flat = style === 'flat' || style === 'gradient', fill = custom ? `url(#${this.linId})` : flat ? o.color : `url(#${this.gradId})`;
      this.sphere.setAttribute('fill', fill);
      const eyeFill = o.eyeColor || (lum(hex2(baseHex)) > 0.55 ? '#141416' : '#ffffff');
      const comp = Array.isArray(o.body) ? { c: o.body, sphereR: 0.85, main: 0, head: 0.35, k: 50, d: 13 } : (o.body && o.body.c) ? o.body : COMPOSED[o.body];
      this._comp = comp;
      if (comp) {
        const fit = o.fit === false ? 1 : fitOf(comp);
        this.sR = o.radius * comp.sphereR * fit; { const su = Object.assign({ cx: 0, cy: 0, rx: comp.sphereR, ry: comp.sphereR }, comp.surf || {}); this._surf = { cx: su.cx * fit, cy: su.cy * fit, rx: su.rx * fit, ry: su.ry * fit }; }
        this.sphere.setAttribute('d', ''); this.clipCircle.setAttribute('d', '');
        const head = comp.head == null ? 0.35 : comp.head;
        if (!this._running) { this._hy = this._sy = this.yaw * head; this._hp = this._sp = this.pitch * head; }       // static render: head already turned
        let cs = comp.anim ? comp.anim(comp.c, { t: this._t, dt: this._dt, vel: this._vel, poke: this._pokeS, twitch: this._twitch, mem: this._mem, hy: this._hy, hp: this._hp }) : comp.c;
        if (this._A && this._A.pieces) cs = this._A.pieces(cs);
        if (this._A && this._A.floor) cs = squashFloor(cs, this._A.floor);
        if (fit !== 1) cs = cs.map(p => p.length > 3 ? [p[0] * fit, p[1] * fit, p[2] * fit, p[3] * fit, p[4]] : [p[0] * fit, p[1] * fit, p[2] * fit]);
        const main = comp.main == null ? 0 : comp.main;
        const lagCtx = { pitch: this.pitch, yaw: this.yaw, pitchT: this.tPitch, yawT: this.tYaw };
        if (!this._lagS || this._lagS.length !== cs.length) this._lagS = cs.map(() => 0);
        const kl = this._running ? 1 - Math.exp(-this._dt / 0.25) : 1;                    // lag weight eases over ~250 ms, never switches
        cs = cs.map((c, i) => {
          if (main === -1 || i === main) return c;
          const target = comp.lag ? comp.lag(i, lagCtx) : 0;
          const l = (this._lagS[i] += (target - this._lagS[i]) * kl);
          return headProject(c, this._hy + (this._sy - this._hy) * l, this._hp + (this._sp - this._hp) * l);
        });
        const sig = cs.map(c => c.length > 3 ? 'e' : 'c').join('');
        if (this._sig !== sig) {
          this._sig = sig; this.goo.innerHTML = ''; this.maskGoo.innerHTML = '';
          for (const t of sig) { const n = t === 'e' ? 'ellipse' : 'circle'; this.goo.append(el(n, {})); this.maskGoo.append(el(n, {})); }
        }
        cs.forEach((p, i) => {
          const cx = (100 + p[0] * o.radius).toFixed(2), cy = (100 + p[1] * o.radius).toFixed(2), rr = (p[2] * o.radius).toFixed(2);
          for (const c of [this.goo.children[i], this.maskGoo.children[i]]) {
            c.setAttribute('cx', cx); c.setAttribute('cy', cy);
            if (p.length > 3) { c.setAttribute('rx', rr); c.setAttribute('ry', (p[3] * o.radius).toFixed(2)); c.setAttribute('transform', `rotate(${(p[4] || 0).toFixed(2)} ${cx} ${cy})`); }
            else c.setAttribute('r', rr);
          }
        });
        this.blur.setAttribute('stdDeviation', (1 + o.round * 13 * (this._A && this._A.roundMul != null ? this._A.roundMul : 1)).toFixed(1));
        for (const c of this.goo.children) c.setAttribute('fill', fill);
      } else {
        const shape = (SHAPES[o.body] || SHAPES.circle)(o.radius);
        this.sR = shape.sphereR; const sr = shape.sphereR / o.radius; this._surf = Object.assign({ cx: 0, cy: 0, rx: sr, ry: sr }, shape.surf || {}); this._sig = ''; this.goo.innerHTML = ''; this.maskGoo.innerHTML = '';
        this.sphere.setAttribute('d', shape.d); this.clipCircle.setAttribute('d', shape.d);
      }
      const tintOver = o.shade === 'gradient' && o.shaded !== false;                                 // shader: a light zone that follows the gaze, blended over the flat colour
      this.lightEl.style.display = this.shadowEl.style.display = tintOver ? '' : 'none';
      if (tintOver) {
        const f = this._frame(0, 28), cx = (f.m[4] - 0.12 * o.radius).toFixed(1), cy = (f.m[5] - 0.1 * o.radius).toFixed(1), r = (1.35 * o.radius).toFixed(1);
        for (const g of [this.lightGrad, this.shadowGrad]) { g.setAttribute('cx', cx); g.setAttribute('cy', cy); g.setAttribute('r', r); }
        const tk = custom ? o.color[0] + '|' + o.color[1] : o.color;
        if (this._tintKey !== tk) {                                                                 // each gradient end gets its own lighter / darker version, so the tint always matches what is under it
          this._tintKey = tk; const c0 = custom ? o.color[0] : o.color, c1 = custom ? o.color[1] : o.color;
          const ls = this.lightLin.children, ss = this.shadowLin.children;
          ls[0].setAttribute('stop-color', tintOf(c0, 1)); ls[1].setAttribute('stop-color', tintOf(c1, 1));
          ss[0].setAttribute('stop-color', tintOf(c0, -1)); ss[1].setAttribute('stop-color', tintOf(c1, -1));
        }
      }
      this.eyeL.setAttribute('fill', eyeFill); this.eyeR.setAttribute('fill', eyeFill); this.starL.setAttribute('fill', eyeFill); this.starR.setAttribute('fill', eyeFill);
      this._wireframe();
      { const ov = this._A && this._A.overlay; this.over.innerHTML = '';
        if (ov) for (const [x, y, r] of ov) this.over.append(el('circle', { cx: (100 + x * o.radius).toFixed(2), cy: (100 + y * o.radius).toFixed(2), r: (r * o.radius).toFixed(2), fill })); }
      if (custom) {                                                                                  // gradient axis anchored on the head sphere: it shifts with the gaze
        const a = (o.gradientAngle == null ? 90 : o.gradientAngle) * D2R, lon = 62 * Math.cos(a), lat = -62 * Math.sin(a);
        const f1 = this._frame(-lon, -lat), f2 = this._frame(lon, lat);
        for (const g of [this.lin, this.lightLin, this.shadowLin]) { g.setAttribute('x1', f1.m[4].toFixed(1)); g.setAttribute('y1', f1.m[5].toFixed(1)); g.setAttribute('x2', f2.m[4].toFixed(1)); g.setAttribute('y2', f2.m[5].toFixed(1)); }
      }
      this.zL = this._eye(this.eyeL, -1);
      this.zR = this._eye(this.eyeR, 1);
      this._mouth(eyeFill);
      const lx = o.lean ? (this.yaw / o.maxYaw) * 3 : 0, ly = o.lean ? (-this.pitch / o.maxPitch) * 2 : 0, A = this._A;
      let tf = `translate(${(lx + (A ? A.dx : 0)).toFixed(2)} ${(ly + (A ? A.dy : 0)).toFixed(2)})`;
      if (A && (A.rot || A.sx !== 1 || A.sy !== 1)) { const py = 100 + o.radius * (A.pivotY == null ? 1 : A.pivotY); tf += ` translate(100 ${py.toFixed(2)}) rotate(${A.rot.toFixed(2)}) scale(${A.sx.toFixed(3)} ${A.sy.toFixed(3)}) translate(-100 ${(-py).toFixed(2)})`; }
      this.body.setAttribute('transform', tf);
    }

    /* ---------- convenience ---------- */
    look(yaw, pitch) { const o = this.o; this.tYaw = Math.max(-o.maxYaw, Math.min(o.maxYaw, yaw)); this.tPitch = Math.max(-o.maxPitch, Math.min(o.maxPitch, pitch)); }
    snap(yaw, pitch) { this.look(yaw, pitch); this.yaw = this.tYaw; this.pitch = this.tPitch; }

    // ---------- export: a standalone SVG with the goo baked into one path (no filters), so Figma and Illustrator open it as plain shapes ----------
    _bakeGoo() {
      const S = 640, k = S / 248, N = S * S, cv = document.createElement('canvas'); cv.width = cv.height = S; const ctx = cv.getContext('2d');
      ctx.fillStyle = '#000';
      for (const c of this.goo.children) {                                                        // 1. rasterise the union of the pieces
        const cx = (+c.getAttribute('cx') + 24) * k, cy = (+c.getAttribute('cy') + 24) * k; ctx.beginPath();
        if (c.tagName === 'ellipse') { const tr = c.getAttribute('transform') || '', mm = tr.match(/rotate\(([-\d.]+)/); ctx.ellipse(cx, cy, +c.getAttribute('rx') * k, +c.getAttribute('ry') * k, (mm ? +mm[1] : 0) * D2R, 0, Math.PI * 2); }
        else ctx.arc(cx, cy, +c.getAttribute('r') * k, 0, Math.PI * 2);
        ctx.fill();
      }
      const px = ctx.getImageData(0, 0, S, S).data; let a = new Float32Array(N), b = new Float32Array(N);
      for (let i = 0; i < N; i++) a[i] = px[i * 4 + 3] / 255;
      const sigma = +this.blur.getAttribute('stdDeviation') * k, d = Math.floor(sigma * 3 * Math.sqrt(2 * Math.PI) / 4 + 0.5);   // 2. three box blurs, as the SVG spec approximates feGaussianBlur
      const box = (src, dst, stride, len, lines, lineStride) => { const r = Math.floor(d / 2), r2 = d - r - 1;
        for (let l = 0; l < lines; l++) { const base = l * lineStride; let sum = 0; for (let i = -r; i <= r2; i++) sum += src[base + Math.min(Math.max(i, 0), len - 1) * stride];
          for (let i = 0; i < len; i++) { dst[base + i * stride] = sum / d; sum += src[base + Math.min(i + r2 + 1, len - 1) * stride] - src[base + Math.max(i - r, 0) * stride]; } } };
      for (let pass = 0; pass < 3; pass++) { box(a, b, 1, S, S, S); box(b, a, S, S, S, 1); }
      const tau = 0.479, f = (i, j) => a[j * S + i] - tau, lerp = (i0, j0, i1, j1) => { const v0 = f(i0, j0), v1 = f(i1, j1), t = v0 / (v0 - v1); return [i0 + 0.5 + (i1 - i0) * t, j0 + 0.5 + (j1 - j0) * t]; };
      const segs = new Map(), pts = new Map();                                                    // 3. marching squares: entry edge -> exit edge, keyed by edge id
      const eid = (e, i, j) => e === 0 ? 'h' + i + ',' + j : e === 1 ? 'v' + (i + 1) + ',' + j : e === 2 ? 'h' + i + ',' + (j + 1) : 'v' + i + ',' + j;
      const ept = (e, i, j) => e === 0 ? lerp(i, j, i + 1, j) : e === 1 ? lerp(i + 1, j, i + 1, j + 1) : e === 2 ? lerp(i, j + 1, i + 1, j + 1) : lerp(i, j, i, j + 1);
      for (let j = 0; j < S - 1; j++) for (let i = 0; i < S - 1; i++) {
        const ins = [f(i, j) > 0, f(i + 1, j) > 0, f(i + 1, j + 1) > 0, f(i, j + 1) > 0]; if (ins.every(v => v) || !ins.some(v => v)) continue;
        let entry = -1; for (let e = 0; e < 8; e++) { const k0 = e % 4, k1 = (e + 1) % 4; if (!ins[k0] && ins[k1]) entry = k0; else if (ins[k0] && !ins[k1] && entry >= 0) { const s0 = eid(entry, i, j), s1 = eid(k0, i, j); if (!segs.has(s0)) { segs.set(s0, s1); pts.set(s0, ept(entry, i, j)); pts.set(s1, ept(k0, i, j)); } entry = -1; } }
      }
      const loops = [], used = new Set();                                                          // 4. link into closed loops
      for (const start of segs.keys()) { if (used.has(start)) continue; const loop = []; let cur = start; while (cur && !used.has(cur)) { used.add(cur); loop.push(pts.get(cur)); cur = segs.get(cur); } if (loop.length > 8) loops.push(loop); }
      const toU = ([x, y]) => [-24 + x / k, -24 + y / k];
      const rdp = (P, tol) => { if (P.length < 3) return P; const [ax, ay] = P[0], [bx, by] = P[P.length - 1]; let mi = 0, md = -1; const L = Math.hypot(bx - ax, by - ay) || 1e-9;
        for (let i = 1; i < P.length - 1; i++) { const dd = Math.abs((bx - ax) * (ay - P[i][1]) - (ax - P[i][0]) * (by - ay)) / L; if (dd > md) { md = dd; mi = i; } }
        return md > tol ? rdp(P.slice(0, mi + 1), tol).slice(0, -1).concat(rdp(P.slice(mi), tol)) : [P[0], P[P.length - 1]]; };
      let dPath = '';
      for (const loop of loops) {                                                                  // 5. simplify, then a closed Catmull-Rom spline as cubic Béziers
        const U = loop.map(toU), h = Math.floor(U.length / 2), P = rdp(U.slice(0, h + 1), 0.12).slice(0, -1).concat(rdp(U.slice(h).concat([U[0]]), 0.12).slice(0, -1));
        const n = P.length, g = i => P[(i + n) % n], fx = v => v.toFixed(2);
        dPath += `M ${fx(P[0][0])} ${fx(P[0][1])} `;
        for (let i = 0; i < n; i++) { const p0 = g(i - 1), p1 = g(i), p2 = g(i + 1), p3 = g(i + 2);
          dPath += `C ${fx(p1[0] + (p2[0] - p0[0]) / 6)} ${fx(p1[1] + (p2[1] - p0[1]) / 6)} ${fx(p2[0] - (p3[0] - p1[0]) / 6)} ${fx(p2[1] - (p3[1] - p1[1]) / 6)} ${fx(p2[0])} ${fx(p2[1])} `; }
        dPath += 'Z ';
      }
      return dPath.trim();
    }
    toSVG(opts = {}) {
      const o = this.o, custom = Array.isArray(o.color), id = opts.id || 'orb', size = opts.size || 240;
      const out = el('svg', { xmlns: NS, viewBox: '-24 -24 248 248', width: size, height: size }), defs = el('defs', {}); out.append(defs);
      const d = this._comp ? this._bakeGoo() : this.sphere.getAttribute('d');
      const clip = el('clipPath', { id: id + '-clip' }); clip.append(el('path', { d })); defs.append(clip);
      let bodyFill = o.color;
      if (custom) { const lin = this.lin.cloneNode(true); lin.setAttribute('id', id + '-fill'); defs.append(lin); bodyFill = `url(#${id}-fill)`; }
      out.append(el('path', { d, fill: bodyFill }));
      if (this.lightEl.style.display !== 'none') {                                                 // shader: shadow under light, both clipped to the body
        const layer = (name, lin, rad, gradG) => {
          const g = el('g', { 'clip-path': `url(#${id}-clip)` });
          if (!custom) { const r = rad.cloneNode(true); r.setAttribute('id', `${id}-${name}`); const col = lin.children[0].getAttribute('stop-color'); for (const st of r.children) st.setAttribute('stop-color', col); defs.append(r);
            g.append(el('rect', { x: -40, y: -40, width: 280, height: 280, fill: `url(#${id}-${name})` })); }
          else { const r = rad.cloneNode(true); r.setAttribute('id', `${id}-${name}-a`); const l = lin.cloneNode(true); l.setAttribute('id', `${id}-${name}`); const mk = el('mask', { id: `${id}-${name}-m` }); mk.append(el('rect', { x: -40, y: -40, width: 280, height: 280, fill: `url(#${id}-${name}-a)` })); defs.append(r, l, mk);
            g.append(el('rect', { x: -40, y: -40, width: 280, height: 280, fill: `url(#${id}-${name})`, mask: `url(#${id}-${name}-m)` })); }
          out.append(g); };
        layer('shadow', this.shadowLin, this.shadowGrad); layer('light', this.lightLin, this.lightGrad);
      }
      const face = el('g', { 'clip-path': `url(#${id}-clip)` }); out.append(face);
      for (const e of [this.eyeL, this.eyeR, this.starL, this.starR, this.mouthEl]) {
        if (e.style.visibility === 'hidden' || e.style.display === 'none' || (e.tagName === 'path' && !e.getAttribute('d'))) continue;
        const c = e.cloneNode(true); c.removeAttribute('style'); face.append(c);
      }
      for (const c of this.over.children) face.append(c.cloneNode(true));
      return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(out);
    }
    set(v) { if (v.eyeScale != null) this.tEyeScale = v.eyeScale; if (v.squash != null) this.tSquash = v.squash; if (v.blink != null) this.blinkAmt = v.blink; if (v.mouth !== undefined) this.tMouth = v.mouth; if (v.mouthSide != null) this.tMouthSide = v.mouthSide; if (v.mouthLen != null) this.tMouthLen = v.mouthLen; if (v.mouthTilt != null) this.tMouthTilt = v.mouthTilt; }
    setNow(v) { this.set(v); this.eyeScale = this.tEyeScale; this.squash = this.tSquash; this.mouth = this.tMouth; this.mouthSide = this.tMouthSide; this.mouthLen = this.tMouthLen; this.mouthTilt = this.tMouthTilt; }

    blink(times = 1) {
      if (this._blinking) return; this._blinking = true;
      const close = 90, hold = 40, open = 150, gap = 110, t0 = performance.now();
      const easeIn = t => t * t, easeOut = t => 1 - (1 - t) * (1 - t);
      const one = close + hold + open, total = one * times + gap * (times - 1);
      const step = now => {
        let t = now - t0;
        if (t >= total) { this.blinkAmt = 0; this._blinking = false; if (!this._running) this.render(); return; }
        const cycle = t % (one + gap);
        let a = 0;
        if (cycle < close) a = easeIn(cycle / close);
        else if (cycle < close + hold) a = 1;
        else if (cycle < one) a = 1 - easeOut((cycle - close - hold) / open);
        this.blinkAmt = a; if (!this._running) this.render();
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }

    // run a scripted act (see ACTS); returns its duration in ms, 0 if the body has no such act
    // acts of the current body as a list: id 'custom1', 'custom2', ... in definition order, plus the body-specific key
    acts() { const a = this._comp && this._comp.acts; return a ? Object.entries(a).map(([key, act], i) => ({ id: 'custom' + (i + 1), key, label: act.label, hint: act.hint, dur: act.dur })) : []; }
    play(name) {
      const comp = this._comp, acts = comp && comp.acts; if (!acts) return 0;
      const n = /^custom(\d+)$/.exec(name), act = n ? Object.values(acts)[+n[1] - 1] : acts[name]; if (!act) return 0;   // 'custom1' works on every body; the key name is an alias
      this._fade = null; this._act = { def: act, t0: performance.now() }; this.manual = true; this.look(0, 0);
      return act.dur * 1000;
    }
    stopAct() { if (this._A) this._fade = { A: this._A, t0: performance.now() }; this._act = null; this._A = null; }
    // mix an act frame toward neutral by k (0 = the act's frame, 1 = idle)
    _blendOut(A, k) {
      const L = (a, b) => a + (b - a) * k, o = this.o, B = {};
      B.rot = L(A.rot, 0); B.dx = L(A.dx, 0); B.dy = L(A.dy, 0); B.sx = L(A.sx, 1); B.sy = L(A.sy, 1); B.pivotY = A.pivotY;
      B.floor = L(A.floor || 0, 0); B.roundMul = L(A.roundMul == null ? 1 : A.roundMul, 1);
      B.eyeScale = L(A.eyeScale, 1); B.eyeSquash = L(A.eyeSquash, 1); B.eyeShake = 0;
      B.eyeStar = L(A.eyeStar || 0, 0);
      B.eyeOrbit = A.eyeOrbit ? L(A.eyeOrbit, Math.round(A.eyeOrbit / 360) * 360) : 0; B.eyeMerge = L(A.eyeMerge || 0, 0); B.orbitScale = L(A.orbitScale || 1, 1);
      const mouthRest = this.mouth == null ? o.mouthCurve : this.mouth;
      B.mouthCurve = A.mouthCurve == null ? null : L(A.mouthCurve, mouthRest);
      B.mouthTrim = A.mouthTrim == null ? null : L(A.mouthTrim, 1); B.mouthLen = A.mouthLen == null ? null : L(A.mouthLen, this.mouthLen);
      B.mouthSide = L(A.mouthSide || 0, this.mouthSide); B.mouthTilt = A.mouthTilt == null ? null : L(A.mouthTilt, this.mouthTilt);
      B.overlay = A.overlay ? A.overlay.map(([x, y, r]) => [x, y, r * (1 - k)]) : null; B.look = null;
      B.pieces = A.pieces ? cs => { const out = A.pieces(cs); return out.map((p, i) => { const q = cs[i]; if (!q || q.length !== p.length) return p; return p.map((v, j) => j === 4 ? L(v, q[j]) : L(v, q[j])); }); } : null;
      return B;
    }
    // run an ad-hoc act definition {dur, run} on any body
    act(def) { this._fade = null; this._act = { def, t0: performance.now() }; if (!def.free) { this.manual = true; this.look(0, 0); } return def.dur * 1000; }
    // surprised: eyes morph into stars and grow, the mouth pulls into a short 'oh', the body gives a small start
    surprise() { return this.act({ dur: 1.7, run: (t, A) => { const inA = E.back(seg(t, 0, 0.28)), out = 1 - E.io(seg(t, 1.2, 1.6)), k = Math.min(inA, out);
      A.eyeStar = clamp01(k); A.eyeScale = 1 + 0.2 * k; A.mouthCurve = 0.4 + 0.5 * k; A.mouthLen = 1 - 0.25 * k; A.dy = -5 * pulse(t, 0, 0.35); A.sy = 1 + 0.03 * pulse(t, 0, 0.35); } }); }
    // thinking: the two eyes orbit their midpoint like a spinner, three turns, easing in and out
    think() { return this.act({ dur: 3.0, run: (t, A) => { const u = seg(t, 0, 2.9), w = S(Math.PI * u); A.eyeOrbit = 1080 * E.io(u); A.eyeScale = 1 + 0.18 * w; A.orbitScale = 1 + 0.28 * w; A.mouthTrim = 1 - E.io(seg(t, 0, 0.9)) + E.io(seg(t, 2.2, 2.95)); } }); }
    twitch(i = 1) { this._twitch = { i, t0: performance.now(), p: 0 }; }   // one ear wiggle on a body whose anim uses it (bear)

    // ---------- status: a persistent state for avatars, set once and left alone ----------
    // 'idle' | 'thinking' | 'speaking' | 'success' | 'error'. Thinking and speaking loop until the status changes.
    get status() { return this._status; }
    setStatus(s) {
      if (s === this._status) return this; const prev = this._status; this._status = s;
      const T = this._runT || (this._runT = []); for (const t of T) clearTimeout(t); T.length = 0;
      if (prev === 'thinking' && this._A) { const r = ((this._A.eyeOrbit % 360) + 540) % 360 - 180; this._A.eyeOrbit = r; }   // spin out the short way
      this.stopAct(); this.manual = false; this.set({ mouth: null, squash: 1, eyeScale: 1, mouthLen: 1, mouthSide: 0, mouthTilt: 0 });
      switch (s) {
        case 'thinking': this.act({ dur: Infinity, run: (t, A) => { const w = E.io(clamp01(t / 0.6)); A.eyeOrbit = 300 * t * w; A.eyeScale = 1 + 0.18 * w; A.orbitScale = 1 + 0.28 * w; A.mouthTrim = 1 - w; } }); break;
        case 'speaking': this.act({ dur: Infinity, free: true, run: (t, A) => { const w = E.io(clamp01(t / 0.25)), f = 0.5 * S(t * 41) + 0.3 * S(t * 26 + 1) + 0.2 * S(t * 58 + 2);   // three sines: talk-like, never repeats visibly
          A.mouthLen = 1 - w * (0.22 + 0.18 * f); A.mouthCurve = 0.4 - w * (0.15 - 0.25 * f); A.eyeScale = 1 + 0.03 * w * f; } }); break;
        case 'success': this.run('surprise').then(() => { if (this._status === 'success') this.set({ mouth: 0.9 }); }); break;
        case 'error': this.set({ mouth: -0.6, squash: 0.82 }); this.manual = true; [[-7, 0], [7, 0], [-4, 0], [0, 0]].forEach(([y, p], i) => T.push(setTimeout(() => this.look(y, p), 90 * i)));
          T.push(setTimeout(() => { this.manual = false; }, 420)); break;
        default: break;   // idle: everything already reset above
      }
      return this;
    }

    // ---------- scenarios: every catalog scenario as one call ----------
    // run('turn' | 'nod' | 'quick' | 'blink' | 'poke' | 'idle' | 'think' | 'surprise' | 'twitch' | 'custom1' ...)
    // returns a Promise that resolves when the scenario ends; promise.dur is the length in ms. Cursor follow and idle are paused for the run.
    scenarios() { return Object.entries(SCENARIOS).filter(([id]) => id !== 'twitch' || (this._comp && this._comp.anim && /twitch/.test(String(this._comp.anim)))).map(([id, s]) => ({ id, label: s.label, hint: s.hint, dur: s.dur })).concat(this.acts().map(a => ({ id: a.id, label: a.label, hint: a.hint, dur: a.dur * 1000 }))); }
    run(name) {
      const o = this.o, T = this._runT || (this._runT = []); for (const t of T) clearTimeout(t); T.length = 0; this.stopAct();
      const at = (ms, fn) => T.push(setTimeout(fn, ms));
      const seq = (steps, hold) => { steps.forEach(([y, p], i) => at(i * hold, () => this.look(y, p))); at(steps.length * hold, () => this.look(0, 0)); return steps.length * hold + 350; };
      this.manual = true; let dur = 0;
      switch (name) {
        case 'turn':  this.set({ mouth: 0.7 }); dur = seq([[-0.9 * o.maxYaw, 0], [0.9 * o.maxYaw, 0]], 1300); at(dur - 300, () => this.set({ mouth: null })); break;
        case 'nod':   this.set({ mouth: 0.7 }); dur = seq([[0, 0.9 * o.maxPitch], [0, -0.9 * o.maxPitch]], 1300); at(dur - 300, () => this.set({ mouth: null })); break;
        case 'quick': this.set({ mouth: 0.15, mouthLen: 0.8 }); dur = seq([[0.9 * o.maxYaw, 0], [-0.9 * o.maxYaw, 0], [0.9 * o.maxYaw, 0], [-0.9 * o.maxYaw, 0]], 420);
          [1, -1, 1, -1].forEach((d, i) => at(i * 420, () => this.set({ mouthSide: d, mouthTilt: 9 * d })));
          at(dur - 300, () => this.set({ mouth: null, mouthSide: 0, mouthLen: 1, mouthTilt: 0 })); break;
        case 'blink': this.look(0, 0); this.set({ mouth: 0.8 }); this.blink(2); dur = 800; at(700, () => this.set({ mouth: null })); break;
        case 'poke':  this.look(0, 0); this.poke(); dur = 900; break;
        case 'idle':  this.look(0, 0); dur = 2200; break;
        case 'think': dur = this.think(); at(dur - 200, () => this.blink(1)); break;
        case 'surprise': dur = this.surprise(); break;
        case 'twitch': this.look(0, 0); this.twitch(1 + Math.floor(Math.random() * 2)); dur = 650; break;
        default: dur = this.play(name);
      }
      const p = new Promise(res => at(dur, () => { this.manual = false; res(); }));
      p.dur = dur; return p;
    }
    poke() { this._poke = 1; this.set({ eyeScale: 1.22, squash: 1.1, mouth: 0.5, mouthLen: 0.55 }); clearTimeout(this._pokeT); this._pokeT = setTimeout(() => { this.set({ eyeScale: 1, squash: 1, mouth: null, mouthLen: 1 }); this.blink(1); }, 420); }

    start() {
      if (this._running) return; this._running = true;
      this._last = performance.now(); this._nextIdle = this._last + 1500; this._nextBlink = this._last + 2200;
      const reduce = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
      this._reduce = reduce;
      this._onMove = e => { this._ptr = [e.clientX, e.clientY]; this._ptrT = performance.now(); };
      this._onLeave = () => { this._ptr = null; };
      global.addEventListener('pointermove', this._onMove);
      document.addEventListener('pointerleave', this._onLeave);
      // skip work while scrolled out of view
      this._offscreen = false;
      if (global.IntersectionObserver) { this._io = new IntersectionObserver(es => { this._offscreen = !es[0].isIntersecting; }); this._io.observe(this.svg); }
      this.svg.addEventListener('pointerdown', () => { if (this.o.tap) this.poke(); });
      const loop = now => {
        if (!this._running) return;
        if (this._offscreen) { this._last = now; requestAnimationFrame(loop); return; }   // out of view: skip the work (hidden tabs are throttled by the browser already)
        const dt = Math.min(64, now - this._last); this._last = now; const o = this.o;
        // targets
        if (!this.manual) {
          const followed = o.follow && this._ptr && now - this._ptrT < 4000;
          if (followed) {
            const r = this.svg.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            const dx = this._ptr[0] - cx, dy = this._ptr[1] - cy, k = Math.max(120, r.width * 0.9);
            this.look(o.maxYaw * (2 / Math.PI) * Math.atan(dx / k), -o.maxPitch * (2 / Math.PI) * Math.atan(dy / k));
            this._nextIdle = now + 1200;
          } else if (o.idle && now > this._nextIdle && !reduce) {
            const home = Math.random() < 0.35;
            const ny = home ? 0 : (Math.random() * 2 - 1) * o.maxYaw * 0.55, np = home ? 0 : (Math.random() * 2 - 1) * o.maxPitch * 0.4;
            if (Math.abs(ny - this.tYaw) > 28 && Math.random() < 0.5) this.blink();
            this.look(ny, np); this._nextIdle = now + 1200 + Math.random() * 2600;
          }
        }
        if (o.autoBlink && now > this._nextBlink && !reduce && !this._act) { this.blink(Math.random() < 0.2 ? 2 : 1); this._nextBlink = now + 2000 + Math.random() * 4000; }   // no blinking during a scripted act
        // smoothing (fast saccade, exponential ease-out)
        const k = reduce ? 1 : 1 - Math.exp(-dt / 70), k2 = reduce ? 1 : 1 - Math.exp(-dt / 90);
        const prevYaw = this.yaw;
        this.yaw += (this.tYaw - this.yaw) * k; this.pitch += (this.tPitch - this.pitch) * k;
        // scripted act
        if (this._act) {
          const t = (now - this._act.t0) / 1000;
          if (t >= this._act.def.dur) { this._fade = this._A ? { A: this._A, t0: now } : null; this._act = null; this._A = null; }
          else { const A = { rot: 0, dx: 0, dy: 0, sx: 1, sy: 1, pivotY: 1, pieces: null, floor: 0, roundMul: 1, eyeScale: 1, eyeSquash: 1, eyeShake: 0, eyeOrbit: 0, eyeMerge: 0, orbitScale: 1, overlay: null, mouthCurve: null, mouthTrim: null, mouthLen: null, mouthSide: 0, mouthTilt: null, eyeStar: 0, look: null }; this._act.def.run(t, A, { R: o.radius, comp: this._comp, self: this }); if (A.look) this.look(A.look[0], A.look[1]); this._A = A; }
        }
        else if (this._fade) {                                                                  // blend the act's last frame into the idle pose
          const f = (now - this._fade.t0) / 380;
          if (f >= 1) { this._fade = null; this._A = null; }
          else this._A = this._blendOut(this._fade.A, E.io(f));
        }
        // signals for the extra pieces
        this._t = now / 1000; this._dt = dt / 1000;
        const instVel = (this.yaw - prevYaw) / (dt / 1000); this._vel += (instVel - this._vel) * (1 - Math.exp(-dt / 120));
        { const c = this._comp, head = c && c.head != null ? c.head : 0.35, k = c && c.k || 50, d = c && c.d || 13, h = Math.min(dt, 40) / 1000;
          const ty = this.yaw * head, tp = this.pitch * head;
          this._hvy += ((ty - this._hy) * k - this._hvy * d) * h; this._hy += this._hvy * h;
          this._hvp += ((tp - this._hp) * k - this._hvp * d) * h; this._hp += this._hvp * h;
          const ks = k * 0.3, ds = d * Math.sqrt(0.3);                                   // slower spring, same damping ratio
          this._svy += ((ty - this._sy) * ks - this._svy * ds) * h; this._sy += this._svy * h;
          this._svp += ((tp - this._sp) * ks - this._svp * ds) * h; this._sp += this._svp * h; }
        this._poke *= Math.exp(-dt / 420); if (this._poke < 0.002) this._poke = 0;
        this._pokeS += (this._poke - this._pokeS) * (1 - Math.exp(-dt / 90));   // eased-in poke signal for the body
        if (this._twitch) { this._twitch.p = (now - this._twitch.t0) / 520; if (this._twitch.p >= 1) this._twitch = null; }
        else if (o.twitch && !reduce && (!this._nextTwitch || now > this._nextTwitch)) { if (this._nextTwitch) this._twitch = { i: 1 + Math.floor(Math.random() * 2), t0: now, p: 0 }; this._nextTwitch = now + 2500 + Math.random() * 4000; }
        this.eyeScale += (this.tEyeScale - this.eyeScale) * k2; this.squash += (this.tSquash - this.squash) * k2;
        { const target = this.tMouth == null ? o.mouthCurve : this.tMouth; if (this.mouth == null) this.mouth = target; this.mouth += (target - this.mouth) * k2; }
        this.mouthSide += (this.tMouthSide - this.mouthSide) * k2; this.mouthLen += (this.tMouthLen - this.mouthLen) * k2; this.mouthTilt += (this.tMouthTilt - this.mouthTilt) * k2;
        if (o.breathe && !reduce) { const s = 1 + 0.012 * Math.sin(now / 3200 * Math.PI * 2); this.root.setAttribute('transform', `translate(100 100) scale(${s.toFixed(4)}) translate(-100 -100)`); }
        else this.root.removeAttribute('transform');
        this.render();
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }
    stop() { this._running = false; if (this._runT) { for (const t of this._runT) clearTimeout(t); this._runT.length = 0; } global.removeEventListener('pointermove', this._onMove); document.removeEventListener('pointerleave', this._onLeave); if (this._io) { this._io.disconnect(); this._io = null; } }
  }
  const SCENARIOS = {
    turn:     { label: 'Head turn',   dur: 2950, hint: 'Looks to the yaw limit left, then right, then back to centre.' },
    nod:      { label: 'Nod',         dur: 2950, hint: 'Looks to the pitch limit up, then down, then back to centre.' },
    quick:    { label: 'Quick turns', dur: 2030, hint: 'Four fast alternating looks with a smirk toward each turn.' },
    blink:    { label: 'Blink',       dur: 800,  hint: 'Double blink.' },
    poke:     { label: 'Poke',        dur: 900,  hint: 'Eyes pop, then blink. Also fires on tap.' },
    idle:     { label: 'Idle',        dur: 2200, hint: 'Holds centre so the idle motion is visible.' },
    think:    { label: 'Thinking',    dur: 3000, hint: 'The eyes orbit each other like a spinner, three turns, then settle.' },
    surprise: { label: 'Surprised',   dur: 1700, hint: 'The eyes flash into stars and grow, the mouth shrinks, the body gives a small start.' },
    twitch:   { label: 'Ear twitch',  dur: 650,  hint: 'One ear wiggles once (bear).' },
  };
  Mascot.SCENARIOS = SCENARIOS;
  Mascot.PRESETS = PRESETS;
  Mascot.STATUSES = ['idle', 'thinking', 'speaking', 'success', 'error'];
  // a stable look for an id: the same agent always gets the same body and colour
  Mascot.identity = (id, opts = {}) => {
    const bodies = opts.bodies || Object.keys(COMPOSED), colors = opts.colors || Object.values(Mascot.COLORS);
    let h = 2166136261; for (const ch of String(id)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
    return { body: bodies[h % bodies.length], color: colors[(h >>> 8) % colors.length] };
  };
  // a baked, filter-free SVG string for lists: one bake per distinct look, cached
  const staticCache = new Map();
  Mascot.staticSVG = (opts = {}, out = {}) => {
    const key = JSON.stringify([opts, out.size || 240, out.yaw || 0, out.pitch || 0]);
    if (staticCache.has(key)) return staticCache.get(key);
    const svg = document.createElementNS(NS, 'svg'), m = new Mascot(svg, Object.assign({ lean: false }, opts)); m.snap(out.yaw || 0, out.pitch || 0); m.render();
    const text = m.toSVG({ size: out.size || 240, id: out.id || 'orb-' + staticCache.size }); staticCache.set(key, text); return text;
  };
  Mascot.SIZES = { xs: 16, sm: 24, md: 32, lg: 48, xl: 64, '2xl': 96, '3xl': 128, hero: 240 };   // size tokens, px
  global.Mascot = Mascot; Mascot.SHAPES = Object.keys(SHAPES); Mascot.ACTS = ACTS; Mascot.SHADES = ['flat', 'gradient', 'soft', 'glossy', 'rim']; Mascot.COMPOSED = COMPOSED; Mascot.blob = blobBody; Mascot.BODIES = [...Object.keys(SHAPES), ...Object.keys(COMPOSED)]; Mascot.COLORS = { black: '#0a0a0a', blue: '#1E6DF6', olive: '#969640', cyan: '#00CCFF', orchid: '#CF72D9', lime: '#EEF679' };
  // the same six, adapted for a dark ground: black becomes an off-white body, the others are lifted a step
  Mascot.COLORS_DARK = { black: '#ECECEA', blue: '#5A92FF', olive: '#B4B45C', cyan: '#4DDCFF', orchid: '#DD93E4', lime: '#F1F78C' }; Mascot.EYES = Object.keys(EYES);
  return Mascot;
});
