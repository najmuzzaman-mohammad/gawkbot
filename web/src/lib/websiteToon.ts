// The website's build of the toon characters and the notch's sounds:
// scripts/website-toon.sh bundles this file to website/toon.js (and the
// stylesheet to website/toon.css). The site runs the same characters and
// plays the same synthesised foley as the notch, so what it shows is what
// the app does.

import { play, unlock } from "../notch/sounds";
import { mountFilm } from "./toon/film";
import { Toon } from "./toon/toon";

(window as unknown as { GawkToon: unknown }).GawkToon = {
  Toon,
  mountFilm,
  play,
  unlock,
};
