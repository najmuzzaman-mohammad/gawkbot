import { post } from "../api/client";
import { isInMacApp, postNative } from "./bridge";
import type { NotchOverlay, OverlayScene } from "./types";

/**
 * Drawings on the screen are computed by the office and drawn by the Mac
 * app; the page carries them across. A scene arrives either in a reply
 * (point, overlay) or pending on the state with a sequence number, and
 * each sequence is drawn once.
 */
export function relayOverlay(
  drawnSeq: number,
  pending: NotchOverlay | undefined,
  draw: (scene: OverlayScene | null) => void,
): number {
  if (!pending || pending.seq === drawnSeq) return drawnSeq;
  draw(pending.scene);
  return pending.seq;
}

/** Hands a scene to the app, when there is one to hand it to. */
export function drawOnScreen(scene: OverlayScene | null): void {
  if (!isInMacApp()) return;
  postNative({ type: "overlay", scene });
}

export interface PointResult {
  found: boolean;
  x: number;
  y: number;
  name?: string;
  seq?: number;
  scene?: OverlayScene | null;
}

/** Points at a control in the window in front, by a few words, and draws right away. */
export async function pointAt(
  query: string,
  label: string,
  seconds = 6,
): Promise<PointResult> {
  const out = await post<PointResult>("/notch/point", {
    query,
    label,
    seconds,
  });
  if (out.found && out.scene) drawOnScreen(out.scene);
  return out;
}
