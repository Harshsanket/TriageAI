import { useEffect, useState } from 'react';

import type {
  DashboardModelUsage,
  DeadLetterDto,
  SystemDashboard,
  SystemManifest,
} from '@triageai/contracts';
import { DashboardModelUsageSchema, SystemDashboardSchema } from '@triageai/contracts';

import { apiFetch, type ApiFailure } from '../host/api';
import { navigate } from '../host/router';

function BarChart({
  label,
  points,
}: {
  label: string;
  points: Array<{ label: string; value: number }>;
}) {
  const max = Math.max(1, ...points.map((point) => point.value));
  return (
    <figure className="dashboard__chart" aria-label={label}>
      <figcaption className="visually-hidden">{label}</figcaption>
      {points.length === 0 ? (
        <p className="dashboard__empty">No data yet.</p>
      ) : (
        <ul>
          {points.slice(-14).map((point) => (
            <li key={point.label}>
              <span className="dashboard__chart-bar" aria-hidden="true">
                <span style={{ height: `${Math.max(4, (point.value / max) * 100)}%` }} />
              </span>
              <span className="dashboard__chart-label">{point.label}</span>
              <span className="dashboard__chart-value">{point.value}</span>
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}

export function AgentShareBar({ agents }: { agents: SystemDashboard['agents'] }) {
  const visible = agents.filter((agent) => agent.runs > 0);
  const total = visible.reduce((sum, agent) => sum + agent.runs, 0);
  if (total === 0) return null;
  return (
    <figure className="dashboard__share" aria-label="Agent activity share">
      <div
        className="dashboard__share-bar"
        role="img"
        aria-label={visible.map((agent) => `${agent.displayName}: ${agent.runs} runs`).join(', ')}
      >
        {visible.map((agent) => (
          <span
            key={agent.id}
            style={{ background: agent.color, width: `${(agent.runs / total) * 100}%` }}
            title={`${agent.displayName}: ${agent.runs} runs`}
          />
        ))}
      </div>
      <figcaption>Runs by agent (last 24 h)</figcaption>
    </figure>
  );
}

function totalUsers(data: SystemDashboard): number {
  const { customer, agent, admin } = data.security.usersByRole;
  return customer + agent + admin;
}

interface HardwareSnapshot {
  [key: string]: unknown;
  capturedAt: string;
  uptimeSec: number;
  cpuCount: number;
  loadAvg: number[];
  memoryTotalBytes: number;
  memoryFreeBytes: number;
  processRssBytes: number;
  processHeapUsedBytes: number;
  queuePending: number;
  queueProcessing: number;
}

const gb = (bytes: number): string => `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;

function bucketLabel(bucket: string, window: string): string {
  const [year, month, day] = bucket.slice(0, 10).split('-');
  const date = `${day}/${month}/${year}`;
  return window === 'day' ? `${date} ${bucket.slice(11, 16)}` : date;
}

function StackedUsage({
  usage,
  group,
  window,
}: {
  usage: DashboardModelUsage;
  group: 'model' | 'agent' | 'module';
  window: string;
}) {
  const totalsByPoint = usage.points.map((point) =>
    group === 'model'
      ? Object.values(point.byModel).reduce(
          (sum, entry) => sum + entry.tokensIn + entry.tokensOut,
          0,
        )
      : Object.values(group === 'agent' ? point.byAgent : point.byModule).reduce(
          (sum, value) => sum + value,
          0,
        ),
  );
  const max = Math.max(1, ...totalsByPoint);
  return (
    <figure className="dashboard__chart" aria-label={`Token usage by ${group}`}>
      {usage.points.length === 0 ? (
        <p className="dashboard__empty">No model calls in this window.</p>
      ) : (
        <ul>
          {usage.points.slice(-31).map((point, index) => (
            <li key={point.bucket}>
              <span className="dashboard__chart-bar" aria-hidden="true">
                <span style={{ height: `${Math.max(4, (totalsByPoint[index]! / max) * 100)}%` }} />
              </span>
              <span className="dashboard__chart-label">{bucketLabel(point.bucket, window)}</span>
              <span className="dashboard__chart-value">
                {totalsByPoint[index]?.toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}
      <figcaption className="dashboard__empty">
        {usage.totals.tokensIn + usage.totals.tokensOut} tokens · {usage.totals.calls} calls ·{' '}
        {usage.totals.failures} failures · {usage.totals.fallbacks} fallbacks ·{' '}
        {usage.totals.timeouts} timeouts
      </figcaption>
    </figure>
  );
}

function UsageSection({
  usage,
  window,
  onWindow,
  from,
  to,
  onFrom,
  onTo,
  group,
  onGroup,
}: {
  usage: DashboardModelUsage | null;
  window: 'day' | 'month' | 'year' | 'custom';
  onWindow: (value: 'day' | 'month' | 'year' | 'custom') => void;
  from: string;
  to: string;
  onFrom: (value: string) => void;
  onTo: (value: string) => void;
  group: 'model' | 'agent' | 'module';
  onGroup: (value: 'model' | 'agent' | 'module') => void;
}) {
  return (
    <article className="dashboard__tile dashboard__tile--triple" aria-labelledby="dashboard-usage">
      <h3 id="dashboard-usage">Usage and performance</h3>
      <div className="dashboard__controls">
        <label>
          Window{' '}
          <select
            aria-label="Usage window"
            value={window}
            onChange={(event) => onWindow(event.target.value as typeof window)}
          >
            <option value="day">Day</option>
            <option value="month">Month</option>
            <option value="year">Year</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        {window === 'custom' && (
          <>
            <label>
              From <input type="date" value={from} onChange={(e) => onFrom(e.target.value)} />
            </label>
            <label>
              To <input type="date" value={to} onChange={(e) => onTo(e.target.value)} />
            </label>
          </>
        )}
        <label>
          Stack by{' '}
          <select
            aria-label="Stack token usage by"
            value={group}
            onChange={(event) => onGroup(event.target.value as typeof group)}
          >
            <option value="model">Model</option>
            <option value="agent">Agent</option>
            <option value="module">Module</option>
          </select>
        </label>
      </div>
      {usage ? (
        <>
          <StackedUsage usage={usage} group={group} window={window} />
          <div className="dashboard__table-scroll">
            <table className="dashboard__table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Calls</th>
                  <th>Tokens in/out</th>
                  <th>TTFT mean/p95</th>
                  <th>Tokens/s mean/p95</th>
                  <th>Generation mean/p95</th>
                </tr>
              </thead>
              <tbody>
                {usage.byModel.map((model) => (
                  <tr key={`${model.provider}/${model.model}`}>
                    <td>
                      {model.provider} / {model.model}
                    </td>
                    <td>{model.calls}</td>
                    <td>
                      {model.tokensIn.toLocaleString()} / {model.tokensOut.toLocaleString()}
                    </td>
                    <td>
                      {model.ttftMeanMs == null
                        ? 'not measured'
                        : `${Math.round(model.ttftMeanMs)} / ${Math.round(model.ttftP95Ms ?? 0)} ms`}
                    </td>
                    <td>
                      {model.tokensPerSecondMean == null
                        ? 'not measured'
                        : `${model.tokensPerSecondMean.toFixed(1)} / ${(model.tokensPerSecondP95 ?? 0).toFixed(1)}`}
                    </td>
                    <td>
                      {model.generationMeanMs == null
                        ? 'not measured'
                        : `${Math.round(model.generationMeanMs)} / ${Math.round(model.generationP95Ms ?? 0)} ms`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="dashboard__empty">Usage metrics are unavailable.</p>
      )}
    </article>
  );
}
/** Host-owned admin overview (Phase 19.4 v1): tiles link to their drill-downs. */
export default function DashboardPage({ manifest }: { manifest: SystemManifest }) {
  const [data, setData] = useState<SystemDashboard | null>(null);
  const [error, setError] = useState<ApiFailure | string | null>(null);
  const [usage, setUsage] = useState<DashboardModelUsage | null>(null);
  const [usageWindow, setUsageWindow] = useState<'day' | 'month' | 'year' | 'custom'>('day');
  const [usageFrom, setUsageFrom] = useState('');
  const [usageTo, setUsageTo] = useState('');
  const [usageGroup, setUsageGroup] = useState<'model' | 'agent' | 'module'>('model');
  const [hardware, setHardware] = useState<HardwareSnapshot | null>(null);
  const [deadLetters, setDeadLetters] = useState<DeadLetterDto[]>([]);
  const [connectionCount, setConnectionCount] = useState<number | null>(null);
  const [refreshMs, setRefreshMs] = useState(600_000);

  useEffect(() => {
    void apiFetch<{ refreshMs: number }>('/api/v1/system/dashboard-settings').then((result) => {
      if (result.ok && result.data.refreshMs >= 10_000) setRefreshMs(result.data.refreshMs);
    });
  }, []);

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      const res = await apiFetch<unknown>('/api/v1/system/dashboard');
      if (!res.ok) {
        if (!disposed) {
          setError(res.error.status === 403 ? 'Dashboard is available to admins only.' : res.error);
        }
        return;
      }
      const parsed = SystemDashboardSchema.safeParse(res.data);
      if (!disposed) {
        if (parsed.success) {
          setData(parsed.data);
          setError(null);
        } else setError('The dashboard returned an unexpected shape.');
      }
    };
    void load();
    const timer = setInterval(load, refreshMs);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [refreshMs]);

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      const params = new URLSearchParams({ window: usageWindow });
      if (usageWindow === 'custom') {
        if (usageFrom) params.set('from', new Date(usageFrom).toISOString());
        if (usageTo) params.set('to', new Date(usageTo).toISOString());
      }
      const res = await apiFetch<unknown>(`/api/v1/system/usage?${params}`);
      if (disposed || !res.ok) return;
      const parsed = DashboardModelUsageSchema.safeParse(res.data);
      if (parsed.success) setUsage(parsed.data);
    };
    void load();
    const timer = setInterval(load, refreshMs);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [usageWindow, usageFrom, usageTo, refreshMs]);

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      const [hw, letters, connections] = await Promise.all([
        apiFetch<HardwareSnapshot>('/api/v1/system/hw'),
        apiFetch<DeadLetterDto[]>('/api/v1/system/deadletters'),
        apiFetch<{ connections: Array<{ status: string }> }>('/api/v1/connections'),
      ]);
      if (disposed) return;
      if (hw.ok) setHardware(hw.data);
      if (letters.ok) setDeadLetters(letters.data);
      if (connections.ok && Array.isArray(connections.data.connections)) {
        setConnectionCount(connections.data.connections.length);
      }
    };
    void load();
    const timer = setInterval(load, refreshMs);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [refreshMs]);

  const reloadDashboard = async () => {
    const res = await apiFetch<unknown>('/api/v1/system/dashboard');
    if (!res.ok) return;
    const parsed = SystemDashboardSchema.safeParse(res.data);
    if (parsed.success) setData(parsed.data);
  };

  const toggleLlm = async (patch: Record<string, unknown>) => {
    await apiFetch('/api/v1/system/controls', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    await reloadDashboard();
  };

  const deadLetterAction = async (id: string, action: 'replay' | 'discard') => {
    await apiFetch(`/api/v1/system/deadletters/${id}${action === 'replay' ? '/replay' : ''}`, {
      method: action === 'replay' ? 'POST' : 'DELETE',
    });
    const res = await apiFetch<DeadLetterDto[]>('/api/v1/system/deadletters');
    if (res.ok) setDeadLetters(res.data);
  };

  const knowledgeEnabled = manifest.modules.some((module) => module.id === 'kb');
  const derivativesEnabled = manifest.modules.some((module) => module.id === 'data-extract');

  return (
    <section className="dashboard">
      <header className="dashboard__header">
        <div>
          <h2>Dashboard</h2>
          <p className="dashboard__subtitle">
            Health, activity, knowledge and security at a glance.
          </p>
        </div>
        {data && (
          <span className="dashboard__stamp">
            Updated {new Date(data.generatedAt).toLocaleTimeString()}
          </span>
        )}
      </header>

      {error && (
        <p role="alert">{typeof error === 'string' ? error : error.envelope.userMessage}</p>
      )}
      {!data && !error && <p>Loading dashboard…</p>}

      {data && (
        <div className="dashboard__grid">
          <article className="dashboard__tile" aria-labelledby="dashboard-health">
            <h3 id="dashboard-health">Health</h3>
            <p className={`dashboard__value dashboard__value--${data.health.status}`}>
              {data.health.status}
            </p>
            <dl className="dashboard__facts">
              <div>
                <dt>Database</dt>
                <dd>{data.health.database}</dd>
              </div>
              <div>
                <dt>Modules</dt>
                <dd>{data.health.modules.length} enabled</dd>
              </div>
              <div>
                <dt>Queue</dt>
                <dd>
                  {data.health.queue.pending} pending · {data.health.queue.processing} processing ·{' '}
                  {data.health.queue.deadLetters} dead
                </dd>
              </div>
            </dl>
            <ul className="dashboard__list" aria-label="Module health">
              {data.health.modules.map((module) => (
                <li key={module.id}>
                  <span>{module.id}</span>
                  <span className={`dashboard__dot dashboard__dot--${module.health}`}>
                    {module.health}
                  </span>
                </li>
              ))}
            </ul>
            <button className="dashboard__link" type="button" onClick={() => navigate('/config')}>
              Open config
            </button>
          </article>

          <article className="dashboard__tile" aria-labelledby="dashboard-activity">
            <h3 id="dashboard-activity">Activity</h3>
            <p className="dashboard__value">{data.activity.activeRuns} active runs</p>
            <dl className="dashboard__facts">
              <div>
                <dt>Last hour</dt>
                <dd>{data.activity.runsLastHour} runs started</dd>
              </div>
            </dl>
            {data.activity.recentRuns.length === 0 ? (
              <p className="dashboard__empty">No runs yet.</p>
            ) : (
              <ul className="dashboard__list" aria-label="Recent runs">
                {data.activity.recentRuns.map((run) => (
                  <li key={run.id}>
                    <button
                      className="dashboard__run"
                      type="button"
                      onClick={() => navigate(`/runs/${run.id}`)}
                    >
                      {run.workflowId}
                    </button>
                    <span className={`dashboard__dot dashboard__dot--${run.status.toLowerCase()}`}>
                      {run.status}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <button className="dashboard__link" type="button" onClick={() => navigate('/runs')}>
              Open runs
            </button>
          </article>

          {knowledgeEnabled && data.knowledge && (
            <article className="dashboard__tile" aria-labelledby="dashboard-knowledge">
              <h3 id="dashboard-knowledge">Knowledge</h3>
              <p className="dashboard__value">{data.knowledge.documents} documents</p>
              <dl className="dashboard__facts">
                <div>
                  <dt>Awaiting approval</dt>
                  <dd>{data.knowledge.pendingApproval}</dd>
                </div>
              </dl>
              <button className="dashboard__link" type="button" onClick={() => navigate('/kb')}>
                Open knowledge base
              </button>
            </article>
          )}

          <article className="dashboard__tile" aria-labelledby="dashboard-cost">
            <h3 id="dashboard-cost">Cost</h3>
            <p className="dashboard__value">${data.cost.todayUsd.toFixed(4)} today</p>
            <dl className="dashboard__facts">
              <div>
                <dt>Month to date</dt>
                <dd>${data.cost.monthToDateUsd.toFixed(4)}</dd>
              </div>
              <div>
                <dt>Tokens today</dt>
                <dd>{data.cost.tokensToday.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Model calls</dt>
                <dd>{data.cost.callsToday}</dd>
              </div>
            </dl>
          </article>

          <article className="dashboard__tile" aria-labelledby="dashboard-efficiency">
            <h3 id="dashboard-efficiency">Efficiency</h3>
            <p className="dashboard__value">
              {data.efficiency.p95LatencyMs == null
                ? 'No calls yet'
                : `p95 ${data.efficiency.p95LatencyMs} ms`}
            </p>
            <dl className="dashboard__facts">
              <div>
                <dt>Average</dt>
                <dd>
                  {data.efficiency.avgLatencyMs == null
                    ? '—'
                    : `${data.efficiency.avgLatencyMs} ms`}
                </dd>
              </div>
              <div>
                <dt>Calls today</dt>
                <dd>{data.efficiency.modelCallsToday}</dd>
              </div>
            </dl>
          </article>

          <article className="dashboard__tile" aria-labelledby="dashboard-models">
            <h3 id="dashboard-models">Model routing</h3>
            <p className="dashboard__value">{data.modelCalls.today} calls today</p>
            {data.modelCalls.byProvider.length === 0 ? (
              <p className="dashboard__empty">No model calls yet.</p>
            ) : (
              <ul className="dashboard__list" aria-label="Calls by provider">
                {data.modelCalls.byProvider.map((provider) => (
                  <li key={provider.provider}>
                    <span>{provider.provider}</span>
                    <span>{provider.calls}</span>
                  </li>
                ))}
              </ul>
            )}
          </article>

          <article
            className="dashboard__tile dashboard__tile--wide"
            aria-labelledby="dashboard-llm"
          >
            <h3 id="dashboard-llm">LLM and agents</h3>
            <label className="dashboard__toggle">
              <input
                type="checkbox"
                role="switch"
                aria-label="Turn off all LLMs"
                checked={!data.llmDisabled}
                onChange={() => void toggleLlm({ llmDisabled: !data.llmDisabled })}
              />
              <span>{data.llmDisabled ? 'Generation is off' : 'Generation is on'}</span>
            </label>
            {data.modelRuntimes.length === 0 ? (
              <p className="dashboard__empty">No model runtime is configured.</p>
            ) : (
              <ul className="dashboard__list" aria-label="Model runtimes">
                {data.modelRuntimes.map((runtime) => (
                  <li key={runtime.id}>
                    <span>
                      {runtime.model || runtime.id} · {runtime.id}
                      {runtime.hosted ? ' · hosted' : ' · local'}
                    </span>
                    <span>
                      <span
                        className={`dashboard__runtime dashboard__runtime--${data.llmDisabled ? 'disabled' : runtime.status}`}
                      >
                        {data.llmDisabled ? 'off' : runtime.status}
                      </span>{' '}
                      <input
                        type="checkbox"
                        role="switch"
                        aria-label={`${runtime.id} enabled`}
                        checked={runtime.enabled && !data.llmDisabled}
                        disabled={data.llmDisabled}
                        onChange={() => {
                          const disabled = data.modelRuntimes
                            .filter((entry) => entry.id !== runtime.id && !entry.enabled)
                            .map((entry) => entry.id);
                          if (runtime.enabled) disabled.push(runtime.id);
                          void toggleLlm({ disabledRuntimes: disabled });
                        }}
                      />
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <button className="dashboard__link" type="button" onClick={() => navigate('/config')}>
              Manage model runtimes
            </button>
          </article>

          <UsageSection
            usage={usage}
            window={usageWindow}
            onWindow={setUsageWindow}
            from={usageFrom}
            to={usageTo}
            onFrom={setUsageFrom}
            onTo={setUsageTo}
            group={usageGroup}
            onGroup={setUsageGroup}
          />

          <article className="dashboard__tile" aria-labelledby="dashboard-uptime">
            <h3 id="dashboard-uptime">Uptime</h3>
            <p className="dashboard__value">
              {data.uptime ? `${data.uptime.systemUptimePct.toFixed(2)}%` : 'not measured'}
            </p>
            <dl className="dashboard__facts">
              <div>
                <dt>API</dt>
                <dd>
                  {data.uptime
                    ? `${Math.floor(data.uptime.apiUptimeSec)} s since boot`
                    : 'not measured'}
                </dd>
              </div>
            </dl>
            {data.uptime && data.uptime.targets.length > 0 ? (
              <ul className="dashboard__list" aria-label="Uptime by target">
                {data.uptime.targets.map((target) => (
                  <li key={target.target}>
                    <span>
                      {target.target} · {target.uptimePct.toFixed(2)}%
                    </span>
                    <span
                      className={`dashboard__dot dashboard__dot--${target.currentOk ? 'healthy' : 'down'}`}
                    >
                      {target.currentOk ? 'up' : 'down'}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="dashboard__empty">Probes appear after the first minute.</p>
            )}
          </article>

          <article className="dashboard__tile" aria-labelledby="dashboard-storage">
            <h3 id="dashboard-storage">Storage</h3>
            <p className="dashboard__value">
              {data.storage ? gb(data.storage.totalBytes) : 'not measured'}
            </p>
            {data.storage ? (
              <ul className="dashboard__list" aria-label="Storage by category">
                {data.storage.byCategory.map((entry) => (
                  <li key={entry.category}>
                    <span>{entry.category}</span>
                    <span>{gb(entry.bytes)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <button className="dashboard__link" type="button" onClick={() => navigate('/kb')}>
              Open knowledge base
            </button>
          </article>

          <article className="dashboard__tile" aria-labelledby="dashboard-connections">
            <h3 id="dashboard-connections">Connected APIs</h3>
            <p className="dashboard__value">
              {connectionCount == null ? 'not measured' : `${connectionCount} configured`}
            </p>
            <button className="dashboard__link" type="button" onClick={() => navigate('/config')}>
              Open connections
            </button>
          </article>

          <article
            className="dashboard__tile dashboard__tile--machine"
            aria-labelledby="dashboard-machine"
          >
            <h3 id="dashboard-machine">Machine</h3>
            {hardware ? (
              <dl className="dashboard__facts">
                <div>
                  <dt>CPU / load</dt>
                  <dd>
                    {hardware.cpuCount} cores · {hardware.loadAvg.join(' / ')}
                  </dd>
                </div>
                <div>
                  <dt>Memory</dt>
                  <dd>
                    {gb(hardware.memoryTotalBytes - hardware.memoryFreeBytes)} used of{' '}
                    {gb(hardware.memoryTotalBytes)}
                  </dd>
                </div>
                <div>
                  <dt>Process</dt>
                  <dd>
                    RSS {gb(hardware.processRssBytes)} · heap {gb(hardware.processHeapUsedBytes)}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="dashboard__empty">Hardware metrics are unavailable.</p>
            )}
          </article>

          <article
            className="dashboard__tile dashboard__tile--wide"
            aria-labelledby="dashboard-deadletters"
          >
            <h3 id="dashboard-deadletters">Dead letters</h3>
            {deadLetters.length === 0 ? (
              <p className="dashboard__empty">No dead-lettered jobs.</p>
            ) : (
              <ul className="dashboard__list" aria-label="Dead letters">
                {deadLetters.map((letter) => (
                  <li key={letter.id}>
                    <span>
                      {letter.queue} · {letter.attempts} attempts ·{' '}
                      {letter.error ?? 'unknown error'}
                    </span>
                    <span>
                      <button
                        type="button"
                        onClick={() => void deadLetterAction(letter.id, 'replay')}
                      >
                        Replay
                      </button>{' '}
                      <button
                        type="button"
                        onClick={() => void deadLetterAction(letter.id, 'discard')}
                      >
                        Discard
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </article>

          <article
            className="dashboard__tile dashboard__tile--wide"
            aria-labelledby="dashboard-agents"
          >
            <h3 id="dashboard-agents">Agents running</h3>
            {data.agents.length === 0 ? (
              <p className="dashboard__empty">No agents have run yet.</p>
            ) : (
              <>
                <AgentShareBar agents={data.agents} />
                <ul className="dashboard__list dashboard__agents" aria-label="Agents">
                  {data.agents.map((agent) => (
                    <li key={agent.id}>
                      <span className="dashboard__agent-name">
                        <span
                          className="dashboard__agent-dot"
                          style={{ background: agent.color }}
                          aria-hidden="true"
                        />
                        {agent.displayName}
                      </span>
                      <span>
                        {agent.runs} runs · {agent.tokens.toLocaleString()} tokens · $
                        {agent.cost.toFixed(4)}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <button className="dashboard__link" type="button" onClick={() => navigate('/runs')}>
              Open agent runs
            </button>
          </article>

          {knowledgeEnabled && data.knowledgeGrowth && (
            <article
              className="dashboard__tile dashboard__tile--wide"
              aria-labelledby="dashboard-growth"
            >
              <h3 id="dashboard-growth">Knowledge growth</h3>
              <BarChart
                label="Documents added per day"
                points={data.knowledgeGrowth.points.map((point) => ({
                  label: bucketLabel(point.bucket, 'month'),
                  value: point.documents,
                }))}
              />
              <dl className="dashboard__facts">
                <div>
                  <dt>Ingest jobs (14 d)</dt>
                  <dd>{data.knowledgeGrowth.ingestJobs}</dd>
                </div>
                <div>
                  <dt>Failures</dt>
                  <dd>{data.knowledgeGrowth.failures}</dd>
                </div>
              </dl>
              <button className="dashboard__link" type="button" onClick={() => navigate('/kb')}>
                Open knowledge base
              </button>
            </article>
          )}

          {derivativesEnabled && data.pinnedDatasets.length > 0 && (
            <article
              className="dashboard__tile dashboard__tile--wide"
              aria-labelledby="dashboard-datasets"
            >
              <h3 id="dashboard-datasets">Your data</h3>
              <ul className="dashboard__list" aria-label="Pinned datasets">
                {data.pinnedDatasets.map((dataset) => (
                  <li key={dataset.id}>
                    <button
                      className="dashboard__run"
                      type="button"
                      onClick={() => navigate('/data-extract')}
                    >
                      {dataset.title}
                    </button>
                    <span>
                      {dataset.rowCount} rows
                      {dataset.total == null ? '' : ` · $${dataset.total.toFixed(2)}`}
                    </span>
                  </li>
                ))}
              </ul>
            </article>
          )}

          <article className="dashboard__tile" aria-labelledby="dashboard-security">
            <h3 id="dashboard-security">Security</h3>
            <p className="dashboard__value">{data.security.authMode} auth</p>
            <dl className="dashboard__facts">
              <div>
                <dt>Accounts</dt>
                <dd>{totalUsers(data)}</dd>
              </div>
              <div>
                <dt>Roles</dt>
                <dd>
                  {data.security.usersByRole.customer} customer · {data.security.usersByRole.agent}{' '}
                  agent · {data.security.usersByRole.admin} admin
                </dd>
              </div>
              <div>
                <dt>Audit (24 h)</dt>
                <dd>{data.security.auditEventsLastDay} events</dd>
              </div>
            </dl>
            <button className="dashboard__link" type="button" onClick={() => navigate('/config')}>
              Open config
            </button>
          </article>
        </div>
      )}
    </section>
  );
}
