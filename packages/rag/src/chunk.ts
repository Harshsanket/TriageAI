/** Deterministic paragraph chunker (Phase 4). Max size, no overlap. */
export const DEFAULT_MAX_CHARS = 700;

export function chunkText(text: string, maxChars = DEFAULT_MAX_CHARS): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    if (paragraph.length <= maxChars) {
      current = paragraph;
      continue;
    }
    // Split an oversized paragraph on sentence-ish boundaries.
    let buffer = '';
    for (const sentence of paragraph.split(/(?<=[.!?])\s+/)) {
      const next = buffer ? `${buffer} ${sentence}` : sentence;
      if (next.length <= maxChars) {
        buffer = next;
      } else {
        if (buffer) chunks.push(buffer);
        buffer = sentence.slice(0, maxChars);
      }
    }
    current = buffer;
  }
  if (current) chunks.push(current);
  return chunks;
}
