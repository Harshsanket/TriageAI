import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { mirrorWorkspace } from '../src/agents/workspace.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('workspace mirror (phase 16)', () => {
  it('writes state, progress, decisions and the handoff', async () => {
    const root = await mkdtemp(join(tmpdir(), 'triageai-workspace-'));
    roots.push(root);
    const result = await mirrorWorkspace({
      root,
      agentId: 'agent-1',
      runId: 'run-1',
      goal: 'Resolve the ticket',
      status: 'SUCCEEDED',
      state: { plan: ['read', 'reply'] },
      steps: [{ at: '2026-10-30T01:00:00Z', summary: 'read ticket' }],
      decisions: [
        {
          at: '2026-10-30T01:01:00Z',
          decision: 'use KB',
          reason: 'grounded',
          alternatives: ['memory'],
        },
      ],
      handoff: '# Done',
    });
    expect(result.directory).toContain(join('agents', 'agent-1', 'run-1'));
    expect(await readFile(join(result.directory, 'state.json'), 'utf8')).toContain(
      'Resolve the ticket',
    );
    expect(await readFile(join(result.directory, 'log', 'progress.md'), 'utf8')).toContain(
      'read ticket',
    );
    expect(
      await readFile(join(result.directory, 'decisions', '0001-decision.md'), 'utf8'),
    ).toContain('use KB');
    expect(await readFile(join(result.directory, 'handoff.md'), 'utf8')).toBe('# Done');
  });
});
