/** Read a human summary out of a stored approval preview (no schema required). */
export function previewSummary(preview: unknown): string | null {
  if (typeof preview !== 'object' || preview === null || Array.isArray(preview)) return null;
  const summary = (preview as { summary?: unknown }).summary;
  return typeof summary === 'string' && summary.trim().length > 0 ? summary.trim() : null;
}
