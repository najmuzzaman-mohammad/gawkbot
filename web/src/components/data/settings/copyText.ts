import { showNotice } from "../../ui/Toast";

/** Copies an identifier and says so; on failure the value is shown instead. */
export async function copyText(value: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    showNotice(`${what} copied.`, "success");
  } catch {
    showNotice(`Could not copy. The value is ${value}.`, "error");
  }
}
