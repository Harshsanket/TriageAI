/** Shared candidate helpers (review queue + fixture export). */

/** Normalize a candidate input into the text a classifier/eval consumes. */
export function candidateText(input: unknown): string {
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    const subject = typeof record.subject === 'string' ? record.subject : '';
    const body =
      typeof record.body === 'string'
        ? record.body
        : typeof record.text === 'string'
          ? record.text
          : '';
    const text = `${subject}\n\n${body}`.trim();
    if (text) return text;
  }
  return JSON.stringify(input);
}
