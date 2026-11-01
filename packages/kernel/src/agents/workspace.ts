/** Local workspace mirror (Phase 16.T6): a human-readable copy of run state. */
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface WorkspaceMirrorInput {
  root: string;
  agentId: string;
  runId: string;
  goal: string;
  status: string;
  state: unknown;
  steps: Array<{ at: string; summary: string }>;
  decisions: Array<{ at: string; decision: string; reason: string; alternatives?: string[] }>;
  handoff?: string;
  artifacts?: string[];
}

export interface WorkspaceMirrorResult {
  directory: string;
  files: string[];
}

export async function mirrorWorkspace(input: WorkspaceMirrorInput): Promise<WorkspaceMirrorResult> {
  if (!/^[a-zA-Z0-9_-]+$/.test(input.agentId) || !/^[a-zA-Z0-9_-]+$/.test(input.runId)) {
    throw new Error('agentId and runId must be path-safe');
  }
  const directory = resolve(input.root, 'agents', input.agentId, input.runId);
  if (!directory.startsWith(`${resolve(input.root)}/`)) throw new Error('unsafe workspace path');
  await mkdir(join(directory, 'log'), { recursive: true });
  await mkdir(join(directory, 'decisions'), { recursive: true });

  const files = [
    join(directory, 'state.json'),
    join(directory, 'handoff.md'),
    join(directory, 'log', 'progress.md'),
    ...input.decisions.map((_, index) =>
      join(directory, 'decisions', `${String(index + 1).padStart(4, '0')}-decision.md`),
    ),
  ];
  await writeFile(
    join(directory, 'state.json'),
    JSON.stringify(
      {
        goal: input.goal,
        status: input.status,
        state: input.state,
        artifacts: input.artifacts ?? [],
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(directory, 'handoff.md'),
    input.handoff ?? `# Handoff\n\nGoal: ${input.goal}\nStatus: ${input.status}\n`,
  );
  for (const step of input.steps) {
    await appendFile(join(directory, 'log', 'progress.md'), `- ${step.at} — ${step.summary}\n`);
  }
  for (let index = 0; index < input.decisions.length; index += 1) {
    const decision = input.decisions[index]!;
    await writeFile(
      join(directory, 'decisions', `${String(index + 1).padStart(4, '0')}-decision.md`),
      `# ${decision.decision}\n\nAt: ${decision.at}\n\nReason: ${decision.reason}\n\nRejected: ${
        (decision.alternatives ?? []).join(', ') || 'none'
      }\n`,
    );
  }
  return { directory, files };
}
