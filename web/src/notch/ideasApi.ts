import { post } from "../api/client";

/** The idea was on screen: it counts as seen. Owner only. */
export function markIdeaSeen(id: string) {
  return post("/notch/ideas/seen", { id }).then(() => undefined);
}

/** No: the idea rests; twice, and it is gone for good. Owner only. */
export function dismissIdea(id: string) {
  return post("/notch/ideas/dismiss", { id }).then(() => undefined);
}

/** Yes, make it and go: the bot is created and sent on its first task. Owner only. */
export function acceptIdea(id: string) {
  return post<{ ok: boolean; slug: string }>("/notch/ideas/accept", { id });
}

/** A look by hand, once an hour. Owner only. */
export function scanIdeas() {
  return post("/notch/ideas/scan", {}).then(() => undefined);
}
