// film.ts — the print: grain, a vignette and a flicker laid over a stage,
// so what plays on it reads as a frame of 1930s film. The overlay is one
// element with the look in styles/toon.css; it jumps on twos like the
// characters. Under reduced motion it holds still.

import "../../styles/toon.css";

/** Lays the film look over `host` (which must be positioned). Returns a remover. */
export function mountFilm(host: HTMLElement): () => void {
  const el = document.createElement("div");
  el.className = "toon-film";
  el.setAttribute("aria-hidden", "true");
  host.appendChild(el);
  return () => el.remove();
}
