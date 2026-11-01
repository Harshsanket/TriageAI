/** Structure-aware deterministic chunker (Phase 13.T7). Max size, no overlap;
 * headings, lists, tables and fenced code blocks are kept with their section. */
export const DEFAULT_MAX_CHARS = 700;

export interface DocumentChunk {
  text: string;
  headingPath: string;
}

interface Section {
  headingPath: string;
  blocks: string[];
}

function collectSections(text: string): Section[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const sections: Section[] = [];
  const stack: string[] = [];
  let current: Section = { headingPath: '', blocks: [] };
  let fence: string | null = null;
  let block: string[] = [];

  const flushBlock = () => {
    const value = block.join('\n').trim();
    if (value) current.blocks.push(value);
    block = [];
  };
  const flushSection = () => {
    flushBlock();
    if (current.blocks.length > 0) sections.push(current);
  };

  for (const line of lines) {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      if (!fence) {
        flushBlock();
        fence = fenceMatch[1] ?? '```';
        block.push(line);
        continue;
      }
      if (line.trim().startsWith(fence)) {
        block.push(line);
        fence = null;
        flushBlock();
        continue;
      }
    }
    if (fence) {
      block.push(line);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flushSection();
      const level = heading[1]?.length ?? 1;
      stack.length = Math.min(stack.length, level - 1);
      stack[level - 1] = heading[2]?.trim() ?? '';
      current = { headingPath: stack.filter(Boolean).join(' › '), blocks: [] };
      continue;
    }
    if (line.trim() === '') {
      flushBlock();
      continue;
    }
    block.push(line);
  }
  flushSection();
  return sections;
}

function splitBlock(block: string, maxChars: number): string[] {
  if (block.length <= maxChars) return [block];
  if (block.startsWith('```') || block.startsWith('~~~')) {
    const lines = block.split('\n');
    const chunks: string[] = [];
    let buffer = '';
    for (const line of lines) {
      const next = buffer ? `${buffer}\n${line}` : line;
      if (next.length <= maxChars) buffer = next;
      else {
        if (buffer) chunks.push(buffer);
        buffer = line.slice(0, maxChars);
      }
    }
    if (buffer) chunks.push(buffer);
    return chunks;
  }
  const pieces: string[] = [];
  let buffer = '';
  for (const sentence of block.split(/(?<=[.!?])\s+|\n/)) {
    const next = buffer ? `${buffer} ${sentence}` : sentence;
    if (next.length <= maxChars) buffer = next;
    else {
      if (buffer) pieces.push(buffer);
      buffer = sentence.slice(0, maxChars);
    }
  }
  if (buffer) pieces.push(buffer);
  return pieces;
}

export function chunkDocument(text: string, maxChars = DEFAULT_MAX_CHARS): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];
  for (const section of collectSections(text)) {
    let current = '';
    const push = () => {
      const value = current.trim();
      if (value) chunks.push({ text: value, headingPath: section.headingPath });
      current = '';
    };
    for (const block of section.blocks) {
      for (const piece of splitBlock(block, maxChars)) {
        const candidate = current ? `${current}\n\n${piece}` : piece;
        if (candidate.length <= maxChars) current = candidate;
        else {
          push();
          current = piece;
        }
      }
    }
    push();
  }
  if (chunks.length === 0 && text.trim()) {
    chunks.push({ text: text.trim().slice(0, maxChars), headingPath: '' });
  }
  return chunks;
}

export function chunkText(text: string, maxChars = DEFAULT_MAX_CHARS): string[] {
  return chunkDocument(text, maxChars).map((chunk) => chunk.text);
}
