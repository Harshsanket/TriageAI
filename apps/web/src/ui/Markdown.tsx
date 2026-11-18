import type { ReactNode } from 'react';

/**
 * 18.T28 safe Markdown: no raw HTML, no remote images, links are plain anchors
 * with the real domain shown. Everything is rendered as React text nodes, so
 * markup can never execute.
 */
export function Markdown({ text }: { text: string }) {
  const lines = text.split('\n');
  const blocks: ReactNode[] = [];
  let code: string[] | null = null;
  for (const [index, line] of lines.entries()) {
    if (line.trimStart().startsWith('```')) {
      if (code) {
        blocks.push(
          <pre key={`code-${index}`}>
            <code>{code.join('\n')}</code>
          </pre>,
        );
        code = null;
      } else {
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    if (line.trim() === '') {
      blocks.push(<br key={`br-${index}`} />);
      continue;
    }
    blocks.push(
      <p key={`line-${index}`} className="ui-markdown__line">
        {inline(line)}
      </p>,
    );
  }
  if (code) {
    blocks.push(
      <pre key="code-open">
        <code>{code.join('\n')}</code>
      </pre>,
    );
  }
  return <div className="ui-markdown">{blocks}</div>;
}

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const cleaned = text.replace(/<[^>]*>/g, ''); // raw HTML is inert text
  const pattern = /(!\[[^\]]*\]\([^)]*\))|(\[[^\]]+\]\([^)]+\))|(`[^`]+`)|(\*\*[^*]+\*\*)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(cleaned))) {
    if (match.index > last) out.push(cleaned.slice(last, match.index));
    const token = match[0];
    if (token.startsWith('![')) {
      out.push(<span key={`img-${match.index}`}>[image removed]</span>);
    } else if (token.startsWith('[')) {
      const link = /\[([^\]]+)\]\(([^)]+)\)/.exec(token);
      if (link) out.push(renderLink(link[1] ?? '', link[2] ?? '', match.index));
    } else if (token.startsWith('`')) {
      out.push(<code key={`code-${match.index}`}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**')) {
      out.push(<strong key={`strong-${match.index}`}>{token.slice(2, -2)}</strong>);
    }
    last = match.index + token.length;
  }
  if (last < cleaned.length) out.push(cleaned.slice(last));
  return out;
}

function renderLink(label: string, url: string, key: number): ReactNode {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return <span key={`link-${key}`}>{label}</span>;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return <span key={`link-${key}`}>{label}</span>;
  }
  return (
    <a
      key={`link-${key}`}
      href={parsed.toString()}
      target="_blank"
      rel="noreferrer noopener"
      title={parsed.toString()}
    >
      {label || parsed.hostname} <span className="ui-markdown__domain">({parsed.hostname})</span>
    </a>
  );
}
