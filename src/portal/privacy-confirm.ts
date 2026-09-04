/** The word a person types before everything about them is erased. */
export const ERASE_WORD = "ERASE";

/**
 * Does the request body prove a person confirmed this privacy action? The
 * portal link alone can be forwarded, prefetched, or pasted somewhere, so
 * the destructive endpoints need a second signal that came from the dialog.
 */
export function privacyConfirmed(action: string, confirm: unknown): boolean {
  if (action === "erase-all") return typeof confirm === "string" && confirm.trim() === ERASE_WORD;
  return confirm === true;
}
