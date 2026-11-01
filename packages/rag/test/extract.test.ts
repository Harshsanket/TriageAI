import { describe, expect, it } from 'vitest';

import { extractText, mediaTypeFor } from '../src/extract.js';

function zip(files: Record<string, string>): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = centrals.reduce((sum, chunk) => sum + chunk.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, ...centrals, eocd]));
}

describe('text extraction (phase 20.4)', () => {
  it('extracts text, markdown, HTML and JSON', () => {
    expect(extractText(new TextEncoder().encode('# Title\n\nBody'), 'text/markdown')).toEqual({
      kind: 'text',
      text: '# Title\n\nBody',
    });
    expect(
      extractText(
        new TextEncoder().encode('<h1>Hi</h1><script>x()</script><p>A &amp; B</p>'),
        'text/html',
      ).text,
    ).toBe('Hi\nA & B');
    expect(mediaTypeFor('README.md')).toBe('text/markdown');
  });

  it('extracts the PDF text layer', () => {
    const pdf = [
      '%PDF-1.4',
      '1 0 obj << /Length 62 >>',
      'stream',
      'BT (2026-09-05 WHOLE FOODS -120.00 875.50) Tj ET',
      'endstream',
      'endobj',
      '%%EOF',
    ].join('\n');
    const extracted = extractText(new TextEncoder().encode(pdf), 'application/pdf');
    expect(extracted.kind).toBe('pdf');
    expect(extracted.text).toContain('WHOLE FOODS -120.00 875.50');
  });

  it('extracts DOCX paragraphs and XLSX rows', () => {
    const docx = zip({
      'word/document.xml':
        '<w:document><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p><w:p><w:r><w:t>World</w:t></w:r></w:p></w:body></w:document>',
    });
    expect(
      extractText(docx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
        .text,
    ).toBe('Hello\nWorld');

    const xlsx = zip({
      'xl/sharedStrings.xml': '<sst><si><t>Date</t></si><si><t>Amount</t></si></sst>',
      'xl/worksheets/sheet1.xml':
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>2026-09-01</t></is></c><c r="B2"><v>4.5</v></c></row></sheetData></worksheet>',
    });
    expect(
      extractText(xlsx, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').text,
    ).toBe('Date\tAmount\n2026-09-01\t4.5');
  });
});
