/**
 * Read a string field from a form post, trimmed. Non-string entries (File
 * uploads, absent keys) become "". Single shared copy — this helper used to
 * be re-declared in actions.ts, admin-actions.ts, and inbox-actions.ts.
 */
export function formValue(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}
