/**
 * Deterministic text extraction for knowledge sources (Phase 20.2/20.4).
 * Text formats are decoded directly; PDF uses the text layer; DOCX and XLSX
 * are ZIP+XML. The output is untrusted data (18.10) — extraction never executes
 * content and OCR is an optional ai-service adapter, not a hard dependency.
 */
import { inflateRawSync } from 'node:zlib';

export interface ExtractedText {
  text: string;
  kind: 'text' | 'pdf' | 'docx' | 'xlsx' | 'binary';
}

const TEXT_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/md',
  'text/csv',
  'text/tab-separated-values',
  'text/html',
  'application/json',
  'application/xml',
  'text/xml',
  'application/x-yaml',
  'text/yaml',
]);

const EXT_TYPES: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  html: 'text/html',
  htm: 'text/html',
  json: 'application/json',
  xml: 'application/xml',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export function mediaTypeFor(name: string, fallback = 'application/octet-stream'): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return EXT_TYPES[ext] ?? fallback;
}

export function extractText(bytes: Uint8Array, mediaType: string): ExtractedText {
  const type = mediaType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (type === 'application/pdf') return { text: pdfText(bytes), kind: 'pdf' };
  if (type.includes('wordprocessingml')) return { text: docxText(bytes), kind: 'docx' };
  if (type.includes('spreadsheetml')) return { text: xlsxText(bytes), kind: 'xlsx' };
  if (TEXT_TYPES.has(type)) {
    const text = new TextDecoder().decode(bytes);
    return { text: type === 'text/html' ? htmlToText(text) : text, kind: 'text' };
  }
  const decoded = new TextDecoder().decode(bytes);
  // Best effort for an unknown text-ish file; binary garbage is rejected by
  // the caller because it fails to produce searchable chunks.
  const printable = [...decoded]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 32 || code === 9 || code === 10 || code === 13;
    })
    .join('');
  return { text: printable, kind: 'binary' };
}

// ── HTML ───────────────────────────────────────────────────────────────────--

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)));
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── ZIP (DOCX/XLSX) ─────────────────────────────────────────────────────────

function unzip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let eocd = -1;
  const start = Math.max(0, bytes.length - 65_557);
  for (let i = bytes.length - 22; i >= start; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive (no end-of-central-directory)');
  const entries = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const files = new Map<string, Uint8Array>();
  for (let entry = 0; entry < entries; entry++) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.slice(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
    if (!name || name.endsWith('/')) continue;
    if (view.getUint32(localOffset, true) !== 0x04034b50) continue;
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = bytes.slice(dataStart, dataStart + compressedSize);
    try {
      files.set(name, method === 0 ? raw : new Uint8Array(inflateRawSync(raw)));
    } catch {
      // Skip a corrupt member; the caller sees missing content.
    }
  }
  return files;
}

function decodeFile(files: Map<string, Uint8Array>, name: string): string {
  const file = files.get(name);
  if (!file) throw new Error(`archive is missing ${name}`);
  return new TextDecoder().decode(file);
}

function xmlText(xml: string): string {
  return decodeEntities(xml.replace(/<[^>]+>/g, ''));
}

// ── DOCX ────────────────────────────────────────────────────────────────────

function docxText(bytes: Uint8Array): string {
  const xml = decodeFile(unzip(bytes), 'word/document.xml');
  return decodeEntities(
    xml
      .replace(/<w:tab\b[^>]*\/>/g, '\t')
      .replace(/<w:br\b[^>]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── XLSX ────────────────────────────────────────────────────────────────────

function xlsxText(bytes: Uint8Array): string {
  const files = unzip(bytes);
  const shared: string[] = [];
  if (files.has('xl/sharedStrings.xml')) {
    const xml = decodeFile(files, 'xl/sharedStrings.xml');
    for (const match of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      shared.push(
        [...(match[1] ?? '').matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
          .map((part) => decodeEntities(part[1] ?? ''))
          .join(''),
      );
    }
  }
  const sheetName =
    [...files.keys()].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort()[0] ??
    'xl/worksheets/sheet1.xml';
  const sheet = decodeFile(files, sheetName);
  const rows: string[] = [];
  for (const rowMatch of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const cellMatch of (rowMatch[1] ?? '').matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1] ?? '';
      const body = cellMatch[2] ?? '';
      const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '';
      const inline = /<is>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? '';
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? '';
      if (type === 's') cells.push(shared[Number(value)] ?? '');
      else if (type === 'inlineStr') cells.push(xmlText(inline));
      else cells.push(decodeEntities(value));
    }
    if (cells.some((cell) => cell.trim() !== '')) rows.push(cells.join('\t'));
  }
  return rows.join('\n');
}

// ── PDF (text layer) ────────────────────────────────────────────────────────

function pdfText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString('latin1');
  const parts: string[] = [];
  for (const object of raw.matchAll(/(\d+)\s+\d+\s+obj([\s\S]*?)endobj/g)) {
    const body = object[2] ?? '';
    const stream = /stream\r?\n([\s\S]*?)\r?\nendstream/.exec(body);
    if (!stream) continue;
    let content = Buffer.from(stream[1] ?? '', 'latin1');
    if (/\/FlateDecode/.test(body.slice(0, body.indexOf('stream')))) {
      try {
        content = inflateRawSync(content);
      } catch {
        continue;
      }
    }
    parts.push(content.toString('latin1'));
  }
  const text = parts
    .map((part) => pdfContentText(part))
    .filter(Boolean)
    .join('\n');
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

function pdfUnescape(value: string): string {
  return value.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, escape: string) => {
    switch (escape) {
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case '(':
        return '(';
      case ')':
        return ')';
      case '\\':
        return '\\';
      default:
        return String.fromCharCode(Number.parseInt(escape, 8));
    }
  });
}

function pdfContentText(content: string): string {
  const lines: string[] = [];
  let line = '';
  const token = /(\((?:\\.|[^\\)])*\))\s*Tj|\[((?:\\.|[^\]])*)\]\s*TJ|(T\*|Td|TD|ET)/g;
  for (const match of content.matchAll(token)) {
    if (match[1]) {
      line += pdfUnescape(match[1].slice(1, -1));
    } else if (match[2]) {
      for (const piece of match[2].matchAll(/\((?:\\.|[^\\)])*\)/g)) {
        line += pdfUnescape(piece[0].slice(1, -1));
      }
    } else if (match[3]) {
      if (line.trim()) lines.push(line.trim());
      line = '';
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines.join('\n');
}
