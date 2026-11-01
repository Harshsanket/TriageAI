import { useEffect, useMemo, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';

import type {
  AgentPreference,
  CatalogModel,
  HardwareProfile,
  SetupAnswers,
  SetupInterface,
  SetupPlan,
  SetupStatus,
} from '@triageai/contracts';
import { AGENT_COLORS } from '@triageai/contracts';

import { getSetupToken, gib, setSetupToken, setupFetch, setupJson } from './setupApi';

type StepId =
  'token' | 'machine' | 'interfaces' | 'agents' | 'knowledge' | 'llm' | 'access' | 'review';

const STEP_TITLES: Record<StepId, string> = {
  token: 'Setup token',
  machine: 'Machine check',
  interfaces: 'What should it do?',
  agents: 'Name your agents',
  knowledge: 'Base knowledge',
  llm: 'Language model',
  access: 'Access & accounts',
  review: 'Review & apply',
};

const INTERFACES: Array<{
  id: SetupInterface | 'public-api' | 'emailer';
  label: string;
  help: string;
  soon?: boolean;
}> = [
  {
    id: 'chatbot',
    label: 'Chatbot',
    help: 'Answers questions from your documents, with citations.',
  },
  {
    id: 'ticket-solver',
    label: 'Ticket solver',
    help: 'Classifies and routes tickets; can auto-reply from the knowledge base.',
  },
  {
    id: 'doc-assistant',
    label: 'Doc assistant',
    help: "Answers questions about this project's own docs.",
  },
  {
    id: 'notifications-github',
    label: 'GitHub issues',
    help: 'Opens an issue per routed ticket (needs the ticket solver).',
  },
  {
    id: 'notifications-slack',
    label: 'Slack notifications',
    help: 'Posts ticket updates to Slack (needs the ticket solver).',
  },
  {
    id: 'public-api',
    label: 'API for other agents',
    help: 'OpenAI-compatible API and MCP server.',
  },
  {
    id: 'emailer',
    label: 'Emailer',
    help: 'Turns email into tickets and replies by email.',
  },
];

const RUNTIMES = [
  {
    id: 'ollama',
    label: 'Ollama',
    help: 'Local runtime; the wizard can download models into it.',
    url: 'http://localhost:11434',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    help: 'Local OpenAI-compatible server.',
    url: 'http://localhost:1234/v1',
  },
  {
    id: 'openai-compatible',
    label: 'Other OpenAI-compatible URL',
    help: 'vLLM, llama.cpp server, …',
    url: 'http://localhost:8080/v1',
  },
  { id: 'none', label: 'No LLM', help: 'Ticket classification and routing only.', url: '' },
] as const;

const DEFAULT_ANSWERS: SetupAnswers = {
  interfaces: ['chatbot'],
  agents: [],
  knowledge: { autoApprove: true, documents: [] },
  llm: { runtime: 'ollama', baseUrl: 'http://localhost:11434', model: undefined },
  ticketSolver: { autoReply: true },
  integrations: {},
  access: { authMode: 'disabled' },
};

interface ApplyResult {
  applied: boolean;
  plan: SetupPlan;
  restarting?: boolean;
  adminCreated?: boolean;
  importsQueued?: number;
}

export function Wizard({
  status,
  onApplied,
  initial,
}: {
  status: SetupStatus;
  onApplied: () => void;
  /** Running answers when re-opened from `/config`; defaults for a first run. */
  initial?: SetupAnswers;
}) {
  const steps = useMemo<StepId[]>(
    () => [
      ...(status.tokenRequired ? (['token'] as StepId[]) : []),
      'machine',
      'interfaces',
      'agents',
      'knowledge',
      'llm',
      'access',
      'review',
    ],
    [status.tokenRequired],
  );
  const [index, setIndex] = useState(() => (status.tokenRequired && getSetupToken() ? 1 : 0));
  const [answers, setAnswers] = useState<SetupAnswers>(initial ?? DEFAULT_ANSWERS);
  const [error, setError] = useState<string | null>(null);
  const step = steps[index] as StepId;

  const update = (patch: Partial<SetupAnswers>) => setAnswers((prev) => ({ ...prev, ...patch }));
  const next = () => {
    setError(null);
    setIndex((i) => Math.min(i + 1, steps.length - 1));
    // Server-side redaction keeps passwords and tokens out of the draft.
    void setupFetch('/api/v1/setup/draft', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(answers),
    }).catch(() => undefined);
  };
  const back = () => setIndex((i) => Math.max(i - 1, 0));

  return (
    <section className="cfg-wizard" aria-labelledby="cfg-title">
      <header className="cfg-wizard__head">
        <p className="cfg-eyebrow">
          {status.state === 'complete' ? 'Change setup' : 'First-run setup'} · step {index + 1} of{' '}
          {steps.length}
        </p>
        <h1 id="cfg-title">{STEP_TITLES[step]}</h1>
        <ol className="cfg-steps" aria-label="Steps">
          {steps.map((id, i) => (
            <li
              key={id}
              aria-current={i === index ? 'step' : undefined}
              className={i < index ? 'is-done' : undefined}
            >
              {STEP_TITLES[id]}
            </li>
          ))}
        </ol>
      </header>

      {status.lastError ? (
        <p className="cfg-alert" role="alert">
          The last applied setup failed to start and was rolled back: {status.lastError}
        </p>
      ) : null}
      {error ? (
        <p className="cfg-alert" role="alert">
          {error}
        </p>
      ) : null}

      {step === 'token' && <TokenStep onValid={next} setError={setError} />}
      {step === 'machine' && <MachineStep onNext={next} />}
      {step === 'interfaces' && <InterfacesStep answers={answers} update={update} />}
      {step === 'agents' && <AgentsStep answers={answers} update={update} />}
      {step === 'knowledge' && <KnowledgeStep answers={answers} update={update} />}
      {step === 'llm' && <LlmStep answers={answers} update={update} />}
      {step === 'access' && <AccessStep answers={answers} update={update} status={status} />}
      {step === 'review' && (
        <ReviewStep answers={answers} onApplied={onApplied} setError={setError} />
      )}

      {step !== 'token' && step !== 'machine' && (
        <footer className="cfg-nav">
          <button type="button" className="cfg-button cfg-button--ghost" onClick={back}>
            Back
          </button>
          {step !== 'review' && (
            <button type="button" className="cfg-button" onClick={next}>
              Continue
            </button>
          )}
        </footer>
      )}
    </section>
  );
}

function TokenStep({
  onValid,
  setError,
}: {
  onValid: () => void;
  setError: (e: string | null) => void;
}) {
  const [token, setToken] = useState('');
  const submit = async () => {
    setSetupToken(token.trim());
    const res = await setupFetch('/api/v1/setup/draft');
    if (res.ok) onValid();
    else {
      setSetupToken(null);
      setError(
        'That token was not accepted. Copy it again from the API log (it changes on every restart).',
      );
    }
  };
  return (
    <div className="cfg-card">
      <p>
        The API printed a one-time setup token when it started. It proves you run this server. Paste
        it here; it stops working once setup is applied.
      </p>
      <label className="cfg-field">
        <span>Setup token</span>
        <input
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <button
        type="button"
        className="cfg-button"
        disabled={!token.trim()}
        onClick={() => void submit()}
      >
        Continue
      </button>
    </div>
  );
}

function MachineStep({ onNext }: { onNext: () => void }) {
  const [hw, setHw] = useState<HardwareProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setupJson<HardwareProfile>('/api/v1/setup/hardware').then(setHw, (e: Error) =>
      setError(e.message),
    );
  }, []);
  if (error) return <p className="cfg-alert">{error}</p>;
  if (!hw) return <p>Checking this machine…</p>;
  return (
    <div className="cfg-card">
      <dl className="cfg-facts">
        <Fact label="Memory">
          {gib(hw.memoryTotalBytes)} total · {gib(hw.memoryFreeBytes)} free
        </Fact>
        <Fact label="CPU">
          {hw.cpuModel} · {hw.cpuCores} cores · {hw.arch}
        </Fact>
        <Fact label="GPU">
          {hw.gpu?.kind === 'cuda'
            ? `${hw.gpu.name} · ${gib(hw.gpu.memoryBytes)}`
            : hw.appleSilicon
              ? 'Apple Silicon (shares system memory)'
              : hw.gpu?.kind === 'mps'
                ? 'Apple GPU'
                : 'None detected'}
        </Fact>
        <Fact label="Free disk">{gib(hw.diskFreeBytes)}</Fact>
        <Fact label="Model budget">
          {gib(hw.modelBudgetBytes)} · {hw.tier} tier
        </Fact>
        <Fact label="Services">
          ai-service {hw.services.aiService ? 'running' : 'not reachable'} · Ollama{' '}
          {hw.services.ollama ? 'running' : 'not reachable'}
        </Fact>
      </dl>
      {!hw.services.aiService && (
        <p className="cfg-hint">
          Embeddings and ticket classification need the ai-service. Start it before using those
          features (SETUP.md §4).
        </p>
      )}
      <button type="button" className="cfg-button" onClick={onNext}>
        Continue
      </button>
    </div>
  );
}

function InterfacesStep({ answers, update }: StepProps) {
  const chosen = new Set(answers.interfaces);
  const toggle = (id: SetupInterface) => {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    update({ interfaces: [...next] });
  };
  return (
    <fieldset className="cfg-card cfg-choices">
      <legend>
        Pick everything this instance should do. You can change it later on this page.
      </legend>
      {INTERFACES.map((item) => (
        <label key={item.id} className={item.soon ? 'cfg-choice is-disabled' : 'cfg-choice'}>
          <input
            type="checkbox"
            disabled={item.soon}
            checked={!item.soon && chosen.has(item.id as SetupInterface)}
            onChange={() => toggle(item.id as SetupInterface)}
          />
          <span>
            <strong>{item.label}</strong>
            {item.soon ? <em> · coming soon</em> : null}
            <small>{item.help}</small>
          </span>
        </label>
      ))}
      {chosen.has('ticket-solver') && (
        <label className="cfg-choice">
          <input
            type="checkbox"
            checked={answers.ticketSolver?.autoReply ?? true}
            onChange={(e) => update({ ticketSolver: { autoReply: e.target.checked } })}
          />
          <span>
            <strong>Auto-reply to tickets</strong>
            <small>
              Send validated answers from the knowledge base; anything uncertain goes to a person.
            </small>
          </span>
        </label>
      )}
    </fieldset>
  );
}

function AgentsStep({ answers, update }: StepProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const interfaceKey = answers.interfaces.join(',');
  const agents = (answers.agents ?? []).filter((agent) =>
    answers.interfaces.includes(agent.interface as SetupInterface),
  );

  useEffect(() => {
    if (answers.interfaces.length === 0) {
      update({ agents: [] });
      return;
    }
    let disposed = false;
    const existing = answers.agents ?? [];
    const missing = answers.interfaces.filter(
      (key) => !existing.some((agent) => agent.interface === key),
    );
    if (missing.length === 0) return;
    const params = new URLSearchParams({
      interfaces: missing.join(','),
      existing: existing.map((agent) => agent.displayName).join(','),
      colors: existing.map((agent) => agent.color).join(','),
    });
    setLoading(true);
    void setupJson<{ agents: AgentPreference[] }>(
      `/api/v1/setup/agent-defaults?${params.toString()}`,
    )
      .then((result) => {
        if (disposed) return;
        const kept = (answers.agents ?? []).filter((agent) =>
          answers.interfaces.includes(agent.interface as SetupInterface),
        );
        update({ agents: [...kept, ...(result.agents ?? [])] });
      })
      .catch((err: Error) => {
        if (!disposed) setError(err.message);
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
    // Re-run only when the chosen interface set changes.
  }, [interfaceKey]);

  const change = (interfaceKeyValue: string, patch: Partial<AgentPreference>) => {
    const next = agents.map((agent) =>
      agent.interface === interfaceKeyValue ? { ...agent, ...patch } : agent,
    );
    update({ agents: next });
  };

  return (
    <fieldset className="cfg-card cfg-choices">
      <legend>
        Every agent gets a name and a colour. NASA spacecraft names are the defaults; rename any of
        them.
      </legend>
      {loading ? <p className="cfg-hint">Choosing names…</p> : null}
      {error ? (
        <p className="cfg-alert" role="alert">
          {error}
        </p>
      ) : null}
      {agents.map((agent) => (
        <div key={agent.interface} className="cfg-agent-row">
          <span className="cfg-agent-row__interface">{agent.interface}</span>
          <label>
            <span className="cfg-label">Name</span>
            <input
              className="cfg-input"
              maxLength={40}
              value={agent.displayName}
              onChange={(event) => change(agent.interface, { displayName: event.target.value })}
            />
          </label>
          <label>
            <span className="cfg-label">Colour</span>
            <select
              className="cfg-select"
              value={agent.color}
              onChange={(event) => change(agent.interface, { color: event.target.value })}
            >
              {AGENT_COLORS.map((color) => (
                <option key={color} value={color}>
                  {color}
                </option>
              ))}
            </select>
          </label>
          <span
            className="cfg-agent-swatch"
            style={{ background: agent.color }}
            aria-hidden="true"
          />
        </div>
      ))}
      {agents.length === 0 && !loading ? (
        <p className="cfg-hint">Choose at least one interface first.</p>
      ) : null}
    </fieldset>
  );
}

function KnowledgeStep({ answers, update }: StepProps) {
  const documents = answers.knowledge?.documents ?? [];
  const [note, setNote] = useState<string | null>(null);
  const onFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    const added: Array<{ title: string; body: string; source: string }> = [];
    const skipped: string[] = [];
    for (const file of files) {
      if (file.size > 200_000) {
        skipped.push(file.name);
        continue;
      }
      const text = await file.text();
      const body = file.name.endsWith('.html') ? stripHtml(text) : text;
      if (body.trim()) added.push({ title: file.name, body, source: `upload:${file.name}` });
    }
    setNote(skipped.length ? `Skipped (over 200 KB): ${skipped.join(', ')}` : null);
    update({
      knowledge: { ...answers.knowledge, documents: [...documents, ...added].slice(0, 50) },
    });
  };
  return (
    <div className="cfg-card">
      <p>
        What should answers be based on? Add Markdown, text or HTML files now, or skip this and add
        documents later in the Knowledge base page. PDF, Word, URL and folder imports are coming.
      </p>
      <label className="cfg-field">
        <span>Documents (.md, .txt, .html — up to 50, 200 KB each)</span>
        <input
          type="file"
          multiple
          accept=".md,.markdown,.txt,.html,.htm"
          onChange={(e) => void onFiles(e)}
        />
      </label>
      {note ? <p className="cfg-hint">{note}</p> : null}
      {documents.length > 0 && (
        <ul className="cfg-list">
          {documents.map((doc, i) => (
            <li key={`${doc.title}-${i}`}>
              {doc.title} · {Math.ceil(doc.body.length / 1000)} KB{' '}
              <button
                type="button"
                className="cfg-link"
                onClick={() =>
                  update({
                    knowledge: {
                      ...answers.knowledge,
                      documents: documents.filter((_, j) => j !== i),
                    },
                  })
                }
              >
                remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="cfg-hint">
        Embeddings use the ai-service model (default all-MiniLM-L6-v2); change it with
        EMBEDDING_MODEL on the ai-service.
      </p>
    </div>
  );
}

function LlmStep({ answers, update }: StepProps) {
  const runtime = answers.llm.runtime;
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [override, setOverride] = useState(false);

  const load = async (q?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const params = new URLSearchParams({ kind: 'generation', ...(q ? { q } : {}) });
      const body = await setupJson<{ models: CatalogModel[] }>(
        `/api/v1/setup/models?${params.toString()}`,
      );
      setModels(body.models);
      if (q && body.models.length === 0) setMessage('No GGUF text-generation models matched.');
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (runtime !== 'none') void load();
  }, [runtime]);

  const choose = (model: string) => update({ llm: { ...answers.llm, model } });
  const selected = models.find((m) => m.runtimeModel === answers.llm.model);

  return (
    <div className="cfg-card">
      <fieldset className="cfg-choices">
        <legend>Where should the model run?</legend>
        {RUNTIMES.map((item) => (
          <label key={item.id} className="cfg-choice">
            <input
              type="radio"
              name="runtime"
              checked={runtime === item.id}
              onChange={() =>
                update({
                  llm: {
                    runtime: item.id,
                    baseUrl: item.url || undefined,
                    model: answers.llm.model,
                  },
                })
              }
            />
            <span>
              <strong>{item.label}</strong>
              <small>{item.help}</small>
            </span>
          </label>
        ))}
      </fieldset>

      {runtime !== 'none' && (
        <>
          <label className="cfg-field">
            <span>Runtime URL</span>
            <input
              value={answers.llm.baseUrl ?? ''}
              onChange={(e) =>
                update({ llm: { ...answers.llm, baseUrl: e.target.value || undefined } })
              }
            />
          </label>
          <form
            className="cfg-search"
            onSubmit={(e) => {
              e.preventDefault();
              void load(query.trim() || undefined);
            }}
          >
            <label className="cfg-field">
              <span>Search Hugging Face (GGUF models) — or pick a recommendation below</span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="e.g. qwen2.5 3b instruct"
              />
            </label>
            <button type="submit" className="cfg-button cfg-button--ghost" disabled={busy}>
              {busy ? 'Searching…' : query.trim() ? 'Search' : 'Show recommended'}
            </button>
          </form>
          {message ? <p className="cfg-hint">{message}</p> : null}
          <table className="cfg-table">
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Size</th>
                <th scope="col">Fit</th>
                <th scope="col">Licence</th>
                <th scope="col">
                  <span className="cfg-sr">Choose</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => {
                const blocked = m.fit === 'too-large' && !override;
                return (
                  <tr key={m.runtimeModel} aria-selected={m.runtimeModel === answers.llm.model}>
                    <td>
                      <code>{m.runtimeModel}</code>
                      {m.note ? <small>{m.note}</small> : null}
                      {m.gated ? <small>Gated: needs a Hugging Face token in Ollama.</small> : null}
                    </td>
                    <td>{gib(m.sizeBytes)}</td>
                    <td>
                      <span className={`cfg-fit cfg-fit--${m.fit}`}>{m.fit.replace('-', ' ')}</span>
                    </td>
                    <td>{m.license ?? '—'}</td>
                    <td>
                      <button
                        type="button"
                        className="cfg-button cfg-button--small"
                        disabled={blocked}
                        onClick={() => choose(m.runtimeModel)}
                      >
                        {m.runtimeModel === answers.llm.model ? 'Selected' : 'Use'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <label className="cfg-choice">
            <input
              type="checkbox"
              checked={override}
              onChange={(e) => setOverride(e.target.checked)}
            />
            <span>
              <strong>Allow models marked “too large”</strong>
              <small>They may not load, or may make the whole machine slow.</small>
            </span>
          </label>
          <label className="cfg-field">
            <span>Model (as the runtime names it)</span>
            <input value={answers.llm.model ?? ''} onChange={(e) => choose(e.target.value)} />
          </label>
          {answers.llm.model && (
            <ModelActions
              runtime={runtime}
              baseUrl={answers.llm.baseUrl}
              model={answers.llm.model}
              fit={selected?.fit}
            />
          )}
        </>
      )}
    </div>
  );
}

function ModelActions({
  runtime,
  baseUrl,
  model,
  fit,
}: {
  runtime: string;
  baseUrl?: string;
  model: string;
  fit?: CatalogModel['fit'];
}) {
  const [progress, setProgress] = useState<string | null>(null);
  const [test, setTest] = useState<string | null>(null);

  const pull = async () => {
    setProgress('Starting download…');
    const res = await setupFetch('/api/v1/setup/models/pull', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl, model }),
    });
    if (!res.ok || !res.body) {
      const body = (await res.json().catch(() => ({}))) as {
        userMessage?: string;
        detail?: string;
      };
      setProgress(`Download failed: ${body.userMessage ?? body.detail ?? res.status}`);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';
      for (const event of events) {
        const data = /^data: (.*)$/m.exec(event)?.[1];
        if (!data) continue;
        try {
          const line = JSON.parse(data) as {
            status?: string;
            completed?: number;
            total?: number;
            error?: string;
          };
          if (line.error) setProgress(`Download failed: ${line.error}`);
          else if (line.total && line.completed)
            setProgress(
              `${line.status ?? 'downloading'} · ${Math.round((line.completed / line.total) * 100)}%`,
            );
          else if (line.status) setProgress(line.status);
        } catch {
          // ignore keep-alives
        }
      }
    }
  };

  const smoke = async () => {
    setTest('Testing…');
    const body: { ok: boolean; latencyMs: number; text?: string; error?: string } =
      await setupJson<{
        ok: boolean;
        latencyMs: number;
        text?: string;
        error?: string;
      }>('/api/v1/setup/llm/test', {
        method: 'POST',
        body: JSON.stringify({ runtime, baseUrl, model }),
      }).catch((err: Error) => ({ ok: false, latencyMs: 0, text: undefined, error: err.message }));
    setTest(
      body.ok
        ? `Answered “${body.text?.trim()}” in ${body.latencyMs} ms.`
        : `Test failed: ${body.error}`,
    );
  };

  return (
    <div className="cfg-actions">
      {runtime === 'ollama' ? (
        <button type="button" className="cfg-button cfg-button--ghost" onClick={() => void pull()}>
          Download into Ollama
        </button>
      ) : (
        <p className="cfg-hint">
          Load this model in {runtime === 'lmstudio' ? 'LM Studio' : 'your server'} first.
        </p>
      )}
      <button type="button" className="cfg-button cfg-button--ghost" onClick={() => void smoke()}>
        Test the model
      </button>
      {fit === 'tight' ? (
        <p className="cfg-hint">This model leaves little memory headroom.</p>
      ) : null}
      {progress ? <p aria-live="polite">{progress}</p> : null}
      {test ? <p aria-live="polite">{test}</p> : null}
    </div>
  );
}

function AccessStep({ answers, update, status }: StepProps & { status: SetupStatus }) {
  const access = answers.access ?? {};
  const integrations = answers.integrations ?? {};
  const wants = new Set(answers.interfaces);
  const setAdmin = (patch: Record<string, string>) =>
    update({
      access: {
        ...access,
        admin: { email: '', password: '', name: '', ...access.admin, ...patch },
      },
    });
  return (
    <div className="cfg-card">
      <fieldset className="cfg-choices">
        <legend>Who can use this instance?</legend>
        <label className="cfg-choice">
          <input
            type="radio"
            name="auth"
            checked={access.authMode !== 'required'}
            onChange={() => update({ access: { ...access, authMode: 'disabled' } })}
          />
          <span>
            <strong>Just me, on this machine</strong>
            <small>
              No sign-in; every request is an admin. Only safe while the API is reachable from this
              machine only.
            </small>
          </span>
        </label>
        <label className="cfg-choice">
          <input
            type="radio"
            name="auth"
            checked={access.authMode === 'required'}
            onChange={() => update({ access: { ...access, authMode: 'required' } })}
          />
          <span>
            <strong>People sign in</strong>
            <small>
              Accounts with roles (customer, agent, admin). Required before sharing it on a network.
            </small>
          </span>
        </label>
      </fieldset>
      <fieldset className="cfg-choices">
        <legend>
          First admin account{' '}
          {access.authMode === 'required' ? '' : '(optional while sign-in is off)'}
        </legend>
        <label className="cfg-field">
          <span>Name</span>
          <input
            value={access.admin?.name ?? ''}
            onChange={(e) => setAdmin({ name: e.target.value })}
          />
        </label>
        <label className="cfg-field">
          <span>Email</span>
          <input
            type="email"
            value={access.admin?.email ?? ''}
            onChange={(e) => setAdmin({ email: e.target.value })}
          />
        </label>
        <label className="cfg-field">
          <span>Password (10+ characters)</span>
          <input
            type="password"
            autoComplete="new-password"
            value={access.admin?.password ?? ''}
            onChange={(e) => setAdmin({ password: e.target.value })}
          />
        </label>
      </fieldset>
      {(wants.has('notifications-github') || wants.has('notifications-slack')) && (
        <fieldset className="cfg-choices">
          <legend>Integration credentials</legend>
          {!status.secretStoreAvailable && (
            <p className="cfg-hint">
              The secret store is off (no TRIAGEAI_SECRET_KEY), so set GITHUB_TOKEN /
              SLACK_WEBHOOK_URL in the environment instead of here.
            </p>
          )}
          {wants.has('notifications-github') && (
            <>
              <label className="cfg-field">
                <span>GitHub repository (owner/name)</span>
                <input
                  value={integrations.githubRepo ?? ''}
                  onChange={(e) =>
                    update({
                      integrations: { ...integrations, githubRepo: e.target.value || undefined },
                    })
                  }
                />
              </label>
              <label className="cfg-field">
                <span>GitHub token</span>
                <input
                  type="password"
                  autoComplete="off"
                  disabled={!status.secretStoreAvailable}
                  value={integrations.githubToken ?? ''}
                  onChange={(e) =>
                    update({
                      integrations: { ...integrations, githubToken: e.target.value || undefined },
                    })
                  }
                />
              </label>
            </>
          )}
          {wants.has('notifications-slack') && (
            <label className="cfg-field">
              <span>Slack webhook URL</span>
              <input
                type="password"
                autoComplete="off"
                disabled={!status.secretStoreAvailable}
                value={integrations.slackWebhookUrl ?? ''}
                onChange={(e) =>
                  update({
                    integrations: { ...integrations, slackWebhookUrl: e.target.value || undefined },
                  })
                }
              />
            </label>
          )}
        </fieldset>
      )}
    </div>
  );
}

function ReviewStep({
  answers,
  onApplied,
  setError,
}: {
  answers: SetupAnswers;
  onApplied: () => void;
  setError: (e: string | null) => void;
}) {
  const [plan, setPlan] = useState<SetupPlan | null>(null);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const payload = useMemo(() => cleanAnswers(answers), [answers]);

  useEffect(() => {
    setupJson<SetupPlan & { issues?: unknown }>('/api/v1/setup/plan', {
      method: 'POST',
      body: JSON.stringify(payload),
    }).then(
      (body) =>
        body.issues
          ? setError('Some answers are incomplete; go back and check each step.')
          : setPlan(body),
      (err: Error) => setError(err.message),
    );
  }, [payload, setError]);

  const apply = async () => {
    setBusy(true);
    try {
      const body = await setupJson<ApplyResult>('/api/v1/setup/apply', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (body.applied) {
        setSetupToken(null);
        setResult(body);
      } else setPlan(body.plan);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <div className="cfg-card" role="status">
        <h2>Saved.</h2>
        <p>
          {result.restarting
            ? 'The API is restarting with the new setup. This page will reload when it is back.'
            : 'Restart the API (stop and start pnpm dev, or the api container) to boot the new setup.'}
        </p>
        {result.importsQueued ? (
          <p>{result.importsQueued} document(s) will be imported after the restart.</p>
        ) : null}
        {result.adminCreated ? <p>Your admin account is ready.</p> : null}
        <button type="button" className="cfg-button" onClick={onApplied}>
          Check again
        </button>
      </div>
    );
  }
  if (!plan) return <p>Working out the plan…</p>;
  return (
    <div className="cfg-card">
      <dl className="cfg-facts">
        <Fact label="Modules">{plan.enabledModules.join(', ') || 'none'}</Fact>
        <Fact label="Model">
          {answers.llm.runtime === 'none'
            ? 'none'
            : `${answers.llm.model} via ${answers.llm.runtime}`}
        </Fact>
        <Fact label="Documents">{answers.knowledge?.documents?.length ?? 0}</Fact>
        <Fact label="Sign-in">{answers.access?.authMode === 'required' ? 'required' : 'off'}</Fact>
        <Fact label="Stored secrets">{plan.secrets.join(', ') || 'none'}</Fact>
      </dl>
      {plan.problems.length > 0 && (
        <div className="cfg-alert" role="alert">
          <strong>Fix these before applying:</strong>
          <ul>
            {plan.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {plan.warnings.length > 0 && (
        <ul className="cfg-hint">
          {plan.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      <details>
        <summary>Config overlay that will be saved</summary>
        <pre className="cfg-pre">{JSON.stringify(plan.overlay, null, 2)}</pre>
      </details>
      <button
        type="button"
        className="cfg-button"
        disabled={busy || plan.problems.length > 0}
        onClick={() => void apply()}
      >
        {busy ? 'Applying…' : 'Apply setup'}
      </button>
    </div>
  );
}

interface StepProps {
  answers: SetupAnswers;
  update: (patch: Partial<SetupAnswers>) => void;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Drop empty optional fields so server validation sees "not given", not "". */
function cleanAnswers(answers: SetupAnswers): SetupAnswers {
  const admin = answers.access?.admin;
  const hasAdmin = admin && (admin.email || admin.password || admin.name);
  return {
    ...answers,
    llm: answers.llm.runtime === 'none' ? { runtime: 'none' } : answers.llm,
    access: { authMode: answers.access?.authMode ?? 'disabled', ...(hasAdmin ? { admin } : {}) },
  };
}

function stripHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc.body.textContent ?? '';
}
