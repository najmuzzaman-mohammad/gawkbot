# orb-mascot (vendored)

Nex's Orb Mascot: the bot characters in gawkbot. `core.js` and `core.d.ts`
are an unmodified copy of `packages/orb-mascot/` from
https://github.com/plyuto-lgtm/orb-mascot at commit bd54b4e, MIT licensed
(see that repository's `packages/orb-mascot/package.json`).

The core is a UMD build that registers `window.Mascot`; `src/lib/orbAvatar.ts`
is the typed entry point the app imports. Do not edit these files: update them
by copying a newer version over and bumping the commit above.
