import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ROUTE_RULES } from '../src/platform/auth/rbac.js';
import {
  LINE_BUDGET,
  checkWorkflowDoc,
  generateRoutesBlock,
  renderWorkflowDoc,
  buildBlocks,
} from '../../../scripts/docs-workflow.js';

const DOC_PATH = path.resolve(process.cwd(), '../../WORKFLOW.md');

describe('WORKFLOW.md generator (phase 19.1)', () => {
  it('committed document matches the generator and has every required section', () => {
    const doc = readFileSync(DOC_PATH, 'utf8');
    expect(checkWorkflowDoc(doc)).toEqual([]);
  });

  it('fails when a generated block drifts from its declarations', () => {
    const doc = readFileSync(DOC_PATH, 'utf8');
    const tampered = doc.replace(
      '<!-- generated:routes -->',
      '<!-- generated:routes -->\n| GET | `/api/v1/drift` | public |',
    );
    expect(checkWorkflowDoc(tampered)).toContainEqual(
      expect.stringContaining('generated blocks are stale'),
    );
  });

  it('changes the routes block when a route is added', () => {
    const before = generateRoutesBlock(ROUTE_RULES);
    const after = generateRoutesBlock([
      ...ROUTE_RULES,
      { method: 'GET', pattern: '/api/v1/docs/drift', roles: ['admin'] },
    ]);
    expect(after).not.toBe(before);
    expect(after).toContain('/api/v1/docs/drift');
  });

  it('fails when a required section is removed or the line budget is exceeded', () => {
    const doc = readFileSync(DOC_PATH, 'utf8');
    expect(checkWorkflowDoc(doc.replace('## 14. Errors and degradation', '## 14. Oops'))).toContain(
      'missing section: "## 14. Errors and degradation"',
    );

    const padded = `${doc}${'\n'.repeat(LINE_BUDGET + 1)}`;
    expect(checkWorkflowDoc(padded)).toContainEqual(expect.stringContaining('budget'));
  });

  it('keeps every generated block in the document', () => {
    const doc = readFileSync(DOC_PATH, 'utf8');
    expect(renderWorkflowDoc(doc, buildBlocks())).toBe(doc);
  });
});
