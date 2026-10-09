// The website's build of the bot characters and the notch's sounds:
// scripts/website-orb.sh bundles this file to website/orb.js (and the
// character's stylesheet to website/orb.css). The site runs the same
// character and plays the same synthesised sounds as the notch, so what it
// shows is what the app does.

import { play, unlock } from "../notch/sounds";
import { mountStarfield, OrbCharacter } from "./orbCharacter";

(window as unknown as { GawkOrb: unknown }).GawkOrb = {
  OrbCharacter,
  mountStarfield,
  play,
  unlock,
};
