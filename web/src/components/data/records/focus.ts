/**
 * True when nothing in particular holds focus. After an inline editor
 * unmounts, this tells "the edit ended with Enter or Escape" (focus fell to
 * <body>, so give it back) apart from "the user clicked or tabbed to another
 * control" (that control has focus and should keep it).
 */
export function focusIsUnclaimed(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body;
}
