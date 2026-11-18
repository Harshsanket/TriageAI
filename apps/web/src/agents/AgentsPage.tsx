import { useCallback, useEffect, useState } from 'react';

import type { ApiFailure } from '../host/api';
import { apiFetch } from '../host/api';
import {
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Field,
  Input,
  Loading,
  Page,
  StatusText,
} from '../ui';

interface AgentRunSummary {
  id: string;
  status: string;
  createdAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

interface AgentRow {
  id: string;
  displayName: string;
  color?: string;
  status: 'running' | 'off' | 'degraded' | 'paused';
  paused: boolean;
  runs: number;
  latestRun: AgentRunSummary | null;
}

interface TeamRow {
  runId: string;
  teamId: string | null;
  topology: string | null;
  status: string;
  agents: number;
  createdAt: string | null;
}

interface PackProfileRow {
  id: string;
  name: string;
  packId: string;
  importedAt: string;
  body: string;
  source: 'pack';
  readOnly: true;
}

interface AgentStepRow {
  runId: string;
  step: number;
  decision: string;
  at: string | null;
  reason: string | null;
  context: { hash?: string; needs?: string[]; tokens?: { total?: number } } | null;
}

interface AgentDetail {
  agent: AgentRow;
  definition: { profile?: string; job?: { doneWhen?: string } } | null;
  runs: AgentRunSummary[];
  steps: AgentStepRow[];
  memory?: {
    entries: AgentMemoryEntry[];
    total: number;
    markdown: string;
  };
}

interface AgentMemoryEntry {
  id: string;
  scope: string;
  scopeId: string;
  kind: string;
  text: string;
  sourceRefs: string[];
  confidence: number;
  status: string;
  useCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  derivedFromUntrusted: boolean;
  sensitivity: string;
}

interface ExternalActivity {
  agents: Array<{ id: string; name: string; enabled: boolean; createdAt: string }>;
  handoffs: Array<{
    id: string;
    agentId: string;
    fromAgentId: string;
    goal: string;
    status: string;
    createdAt: string;
    fetchedAt: string | null;
  }>;
  steps: Array<{
    id: string;
    agentId: string;
    runId: string | null;
    step: string;
    at: string;
  }>;
}

function NewAgentCard({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [id, setId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [profile, setProfile] = useState('');
  const [role, setRole] = useState('');
  const [inputs, setInputs] = useState('');
  const [output, setOutput] = useState('');
  const [doneWhen, setDoneWhen] = useState('');
  const [domain, setDomain] = useState('');
  const [agentReason, setAgentReason] = useState('own_schedule');
  const [tools, setTools] = useState('');
  const [scopes, setScopes] = useState('');
  const [maxSteps, setMaxSteps] = useState('5');
  const [note, setNote] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const res = await apiFetch('/api/v1/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id,
        displayName,
        color: '#3b6fd4',
        version: 1,
        profile,
        job: { role, inputs, output, doneWhen, domain },
        agentReason: agentReason
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
        tools: tools
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
        scopes: scopes
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
        maxSteps: Number(maxSteps),
        egressClass: 'internal',
      }),
    });
    if (res.ok) {
      setNote('Agent created.');
      setOpen(false);
      onCreated();
      return;
    }
    setNote(res.error.envelope.userMessage);
  };

  return (
    <Card title="New agent">
      {note ? <p role="status">{note}</p> : null}
      {!open ? (
        <Button onClick={() => setOpen(true)}>Create agent</Button>
      ) : (
        <form onSubmit={submit} className="cfg-form">
          <Field label="ID">
            <Input value={id} onChange={(event) => setId(event.target.value)} required />
          </Field>
          <Field label="Display name">
            <Input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              required
            />
          </Field>
          <Field label="Profile">
            <Input value={profile} onChange={(event) => setProfile(event.target.value)} required />
          </Field>
          <Field label="Job role">
            <Input value={role} onChange={(event) => setRole(event.target.value)} required />
          </Field>
          <Field label="Inputs">
            <Input value={inputs} onChange={(event) => setInputs(event.target.value)} required />
          </Field>
          <Field label="Output">
            <Input value={output} onChange={(event) => setOutput(event.target.value)} required />
          </Field>
          <Field label="Done when">
            <Input
              value={doneWhen}
              onChange={(event) => setDoneWhen(event.target.value)}
              required
            />
          </Field>
          <Field label="Domain">
            <Input value={domain} onChange={(event) => setDomain(event.target.value)} required />
          </Field>
          <Field label="Agent reason (comma separated)">
            <Input
              value={agentReason}
              onChange={(event) => setAgentReason(event.target.value)}
              required
            />
          </Field>
          <Field label="Tools (comma separated)">
            <Input value={tools} onChange={(event) => setTools(event.target.value)} />
          </Field>
          <Field label="Scopes (comma separated)">
            <Input value={scopes} onChange={(event) => setScopes(event.target.value)} />
          </Field>
          <Field label="Max steps">
            <Input
              type="number"
              min={1}
              max={20}
              value={maxSteps}
              onChange={(event) => setMaxSteps(event.target.value)}
            />
          </Field>
          <div className="cfg-inline">
            <Button type="submit">Create</Button>
            <Button type="button" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
          <p className="cfg-hint">
            No agent reason? <a href="/config">Make it a skill instead</a>.
          </p>
        </form>
      )}
    </Card>
  );
}

/**
 * `/agents` (17.T2): live agent/team runs, per-step timeline and audited
 * pause/resume. External agents come from public-api's own activity route, so
 * the host never reads module tables.
 */
export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [packProfiles, setPackProfiles] = useState<PackProfileRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [external, setExternal] = useState<ExternalActivity | null>(null);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [memoryQuery, setMemoryQuery] = useState('');

  const load = useCallback(async () => {
    const res = await apiFetch<{
      agents: AgentRow[];
      teams: TeamRow[];
      packProfiles?: PackProfileRow[];
    }>('/api/v1/agents');
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError(null);
    setAgents(res.data.agents);
    setTeams(res.data.teams);
    setPackProfiles(res.data.packProfiles ?? []);
    setSelected((current) => current ?? res.data.agents[0]?.id ?? null);
  }, []);

  const loadExternal = useCallback(async () => {
    const res = await apiFetch<ExternalActivity>('/api/v1/public-api/external-agents/activity');
    // The public-api module may be disabled; the monitor stays useful without it.
    setExternal(res.ok ? res.data : null);
  }, []);

  const loadDetail = useCallback(async (agentId: string) => {
    const res = await apiFetch<AgentDetail>(`/api/v1/agents/${encodeURIComponent(agentId)}`);
    setDetail(res.ok ? res.data : null);
  }, []);

  useEffect(() => {
    void load();
    void loadExternal();
    const timer = setInterval(() => {
      void load();
      void loadExternal();
    }, 10_000);
    return () => clearInterval(timer);
  }, [load, loadExternal]);

  useEffect(() => {
    if (selected) void loadDetail(selected);
    setMemoryQuery('');
  }, [selected, loadDetail]);

  const setPaused = async (agent: AgentRow, paused: boolean) => {
    setBusy(true);
    setNote(null);
    const res = await apiFetch<{ agentId: string; paused: boolean }>(
      `/api/v1/agents/${encodeURIComponent(agent.id)}/${paused ? 'pause' : 'resume'}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          reason: paused ? 'paused from /agents monitor' : 'resumed from /agents monitor',
        }),
      },
    );
    setBusy(false);
    if (!res.ok) {
      setNote(res.error.envelope.userMessage);
      return;
    }
    setNote(
      paused
        ? `${agent.displayName} paused. The next step boundary parks the run.`
        : `${agent.displayName} resumed from its last checkpoint.`,
    );
    await load();
    await loadDetail(agent.id);
  };

  const promoteMemory = async (memory: AgentMemoryEntry, target: 'skill' | 'profile') => {
    if (!selected) return;
    setBusy(true);
    setNote(null);
    const res = await apiFetch(
      `/api/v1/agents/${encodeURIComponent(selected)}/memory/${encodeURIComponent(memory.id)}/promote`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target }),
      },
    );
    setBusy(false);
    if (!res.ok) {
      setNote(res.error.envelope.userMessage);
      return;
    }
    setNote(`Lesson promoted to ${target}.`);
    await loadDetail(selected);
  };

  const memoryEntries = detail?.memory?.entries ?? [];
  const memoryFilter = memoryQuery.trim().toLowerCase();
  const visibleMemories = memoryFilter
    ? memoryEntries.filter((entry) =>
        [
          entry.text,
          entry.kind,
          entry.status,
          entry.scope,
          entry.scopeId,
          ...entry.sourceRefs,
        ].some((value) => value.toLowerCase().includes(memoryFilter)),
      )
    : memoryEntries;

  return (
    <Page
      title="Agents"
      subtitle="Definitions, live runs and recent steps. Pause parks the agent at the next step boundary; resume continues from the last checkpoint."
    >
      <ErrorNotice error={error} onRetry={() => void load()} />
      {note ? <p role="status">{note}</p> : null}
      <Card title="Agents">
        {agents === null ? (
          <Loading>Loading agents…</Loading>
        ) : agents.length === 0 ? (
          <EmptyState>No agent definitions or runs yet.</EmptyState>
        ) : (
          <ul className="cfg-list">
            {agents.map((agent) => (
              <li key={agent.id}>
                <div className="cfg-inline">
                  <button
                    type="button"
                    className="app-nav__item"
                    aria-label={`Inspect ${agent.displayName}`}
                    aria-pressed={selected === agent.id}
                    onClick={() => setSelected(agent.id)}
                  >
                    <strong style={agent.color ? { color: agent.color } : undefined}>
                      {agent.displayName}
                    </strong>
                  </button>
                  <StatusText status={agent.status} />
                  <span className="cfg-hint">
                    {agent.runs} run{agent.runs === 1 ? '' : 's'}
                    {agent.latestRun ? ` · latest ${agent.latestRun.status}` : ''}
                  </span>
                  <Button
                    variant={agent.paused ? 'primary' : 'default'}
                    disabled={busy}
                    onClick={() => void setPaused(agent, !agent.paused)}
                  >
                    {agent.paused ? 'Resume' : 'Pause'}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <NewAgentCard onCreated={() => void load()} />

      {detail ? (
        <Card title={`Recent steps · ${detail.agent.displayName}`}>
          {detail.steps.length === 0 ? (
            <EmptyState>This agent has no recorded steps yet.</EmptyState>
          ) : (
            <ol className="cfg-list">
              {detail.steps.map((step) => (
                <li key={`${step.runId}:${step.step}`}>
                  <div className="cfg-inline">
                    <strong>Step {step.step + 1}</strong>
                    <StatusText status={step.decision} />
                    <span className="cfg-hint">
                      {step.at ? new Date(step.at).toLocaleString() : ''}
                      {step.context?.hash ? ` · context ${step.context.hash}` : ''}
                      {step.context?.tokens?.total !== undefined
                        ? ` · ${step.context.tokens.total} tokens`
                        : ''}
                    </span>
                  </div>
                  {step.reason ? <p className="cfg-hint">{step.reason}</p> : null}
                </li>
              ))}
            </ol>
          )}
        </Card>
      ) : null}

      {detail?.memory ? (
        <Card title={`Memory · ${detail.agent.displayName}`}>
          <div className="cfg-inline">
            <Field label="Search memory">
              <Input
                value={memoryQuery}
                placeholder="Search memories"
                onChange={(event) => setMemoryQuery(event.target.value)}
              />
            </Field>
            <a
              className="ui-button ui-button--default"
              download="memory.md"
              href={`data:text/markdown;charset=utf-8,${encodeURIComponent(detail.memory.markdown)}`}
            >
              Export memory.md
            </a>
          </div>
          <p className="cfg-hint">
            {visibleMemories.length} of {detail.memory.total} memories · memory.md lists active
            entries only.
          </p>
          {detail.memory.total === 0 ? (
            <EmptyState>This agent has no memories yet.</EmptyState>
          ) : visibleMemories.length === 0 ? (
            <EmptyState>No memories match this search.</EmptyState>
          ) : (
            <ul className="cfg-list">
              {visibleMemories.map((memory) => (
                <li key={memory.id}>
                  <div className="cfg-inline">
                    <strong>{memory.kind}</strong>
                    <StatusText status={memory.status} />
                    <span className="cfg-hint">
                      {memory.scope}:{memory.scopeId} · used {memory.useCount}
                      {memory.lastUsedAt
                        ? ` · last used ${new Date(memory.lastUsedAt).toLocaleString()}`
                        : ''}
                      {memory.derivedFromUntrusted ? ' · untrusted' : ''}
                      {memory.sensitivity !== 'internal' ? ` · ${memory.sensitivity}` : ''}
                    </span>
                  </div>
                  <p>{memory.text}</p>
                  <p className="cfg-hint">
                    Sources: {memory.sourceRefs.join(', ')} · confidence{' '}
                    {memory.confidence.toFixed(2)}
                  </p>
                  {memory.kind === 'lesson' &&
                  memory.status === 'active' &&
                  !memory.sourceRefs.some((ref) => ref.startsWith('promoted:')) ? (
                    <div className="cfg-inline">
                      <Button disabled={busy} onClick={() => void promoteMemory(memory, 'skill')}>
                        Promote to skill
                      </Button>
                      <Button disabled={busy} onClick={() => void promoteMemory(memory, 'profile')}>
                        Promote to profile
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      {packProfiles.length > 0 ? (
        <Card title="Pack profiles">
          <p className="cfg-hint">
            Imported content-only profiles. They are read-only and are not runnable agents until an
            operator turns one into a definition.
          </p>
          <ul className="cfg-list">
            {packProfiles.map((profile) => (
              <li key={profile.id}>
                <div className="cfg-inline">
                  <strong>{profile.name}</strong>
                  <StatusText status="pack · read-only" />
                  <span className="cfg-hint">
                    {profile.packId} · imported{' '}
                    {profile.importedAt ? new Date(profile.importedAt).toLocaleString() : 'unknown'}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card title="Teams">
        {teams.length === 0 ? (
          <EmptyState>No team runs yet.</EmptyState>
        ) : (
          <ul className="cfg-list">
            {teams.map((team) => (
              <li key={team.runId}>
                <div className="cfg-inline">
                  <strong>{team.teamId ?? team.runId}</strong>
                  <StatusText status={team.status} />
                  <span className="cfg-hint">
                    {team.topology ?? 'team'} · {team.agents} agent
                    {team.agents === 1 ? '' : 's'} · {team.runId}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="External agents">
        {!external || external.agents.length === 0 ? (
          <EmptyState>
            No external agents registered (the public-api module may be disabled).
          </EmptyState>
        ) : (
          <>
            <ul className="cfg-list">
              {external.agents.map((agent) => (
                <li key={agent.id}>
                  <div className="cfg-inline">
                    <strong>{agent.name}</strong>
                    <StatusText status={agent.enabled ? 'enabled' : 'off'} />
                    <span className="cfg-hint">
                      {external.handoffs.filter((row) => row.agentId === agent.id).length} handoffs
                      · {external.steps.filter((row) => row.agentId === agent.id).length} steps
                    </span>
                  </div>
                </li>
              ))}
            </ul>
            {external.handoffs.length > 0 ? (
              <section>
                <h3>Handoffs</h3>
                <ul className="cfg-list">
                  {external.handoffs.slice(0, 10).map((handoff) => (
                    <li key={handoff.id}>
                      <div className="cfg-inline">
                        <strong>{handoff.goal}</strong>
                        <StatusText status={handoff.fetchedAt ? 'fetched' : handoff.status} />
                        <span className="cfg-hint">
                          {handoff.fromAgentId} → {handoff.agentId}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {external.steps.length > 0 ? (
              <section>
                <h3>Reported steps</h3>
                <ul className="cfg-list">
                  {external.steps.slice(0, 10).map((step) => (
                    <li key={step.id}>
                      <div className="cfg-inline">
                        <strong>{step.step}</strong>
                        <span className="cfg-hint">
                          {step.agentId} · {step.at}
                          {step.runId ? ` · run ${step.runId}` : ''}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        )}
      </Card>
    </Page>
  );
}
