import { useEffect, useRef, useState } from 'react';

import type { SetupAnswers, SetupStatus } from '@triageai/contracts';

import './config.css';
import { setupJson, useSetupStatus } from './setupApi';
import { Wizard } from './Wizard';

/**
 * `/config` (ADR-0024): the first-run wizard while setup is pending, and the
 * current setup — status, running config, history and secrets — afterwards,
 * with the wizard one click away for changes.
 */
export default function ConfigPage() {
  const setup = useSetupStatus();
  if (setup.phase === 'loading') return <p>Loading setup…</p>;
  return <ConfigView status={setup.status} refresh={setup.refresh} />;
}

export function ConfigView({ status, refresh }: { status: SetupStatus; refresh: () => void }) {
  useRestartWatcher(status, refresh);

  if (status.state === 'applied') {
    return (
      <section className="cfg-wizard">
        <h1>Restart to finish setup</h1>
        <p>
          The answers are saved. Restart the API (stop and start <code>pnpm dev</code>, or the api
          container) and this page will continue.
        </p>
        <button type="button" className="cfg-button" onClick={refresh}>
          Check again
        </button>
      </section>
    );
  }
  if (status.state === 'pending') {
    return <Wizard status={status} onApplied={refresh} />;
  }
  return <SettingsView status={status} refresh={refresh} />;
}

/**
 * While the API restarts after an apply, poll until the new config is up; a
 * first-run page then reloads into the configured app.
 */
function useRestartWatcher(status: SetupStatus, refresh: () => void) {
  const initial = useRef(status.state);
  useEffect(() => {
    if (initial.current !== 'complete' && status.state === 'complete') {
      window.location.assign('/');
      return;
    }
    if (status.state !== 'applied' && !status.restartRequired) return;
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [status.state, status.restartRequired, refresh]);
}

interface Effective {
  bootedOverlayVersion: number | null;
  latestOverlay: {
    version: number;
    createdBy: string;
    createdAt: string;
    note: string | null;
  } | null;
  history: Array<{ version: number; createdBy: string; createdAt: string; note: string | null }>;
  running: {
    profile: string;
    modules: Record<string, { enabled: boolean; options?: { repo?: string } }>;
    capabilities: Record<string, unknown>;
  };
  authMode: string;
  authModeSource: string;
}

interface SecretList {
  available: boolean;
  secrets: Array<{ name: string; updatedBy: string; updatedAt: string }>;
}

function SettingsView({ status, refresh }: { status: SetupStatus; refresh: () => void }) {
  const [effective, setEffective] = useState<Effective | null>(null);
  const [secrets, setSecrets] = useState<SecretList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    setupJson<Effective>('/api/v1/setup/config/effective').then(setEffective, (e: Error) =>
      setError(e.message),
    );
    setupJson<SecretList>('/api/v1/setup/secrets').then(setSecrets, () => undefined);
  }, [nonce]);

  // Re-open the wizard with the running answers (ADR-0024, Phase 11 AC 5).
  if (editing) {
    return (
      <Wizard
        status={status}
        initial={effective ? answersFromEffective(effective) : undefined}
        onApplied={() => {
          setEditing(false);
          refresh();
        }}
      />
    );
  }

  const enabled = effective
    ? Object.entries(effective.running.modules)
        .filter(([, m]) => m.enabled)
        .map(([id]) => id)
    : [];

  return (
    <section className="cfg-wizard" aria-labelledby="cfg-settings">
      <header className="cfg-wizard__head">
        <p className="cfg-eyebrow">Configuration</p>
        <h1 id="cfg-settings">Setup</h1>
      </header>
      {status.restartRequired && (
        <p className="cfg-alert" role="status">
          A newer configuration is saved. Restart the API to use it.
        </p>
      )}
      {error ? <p className="cfg-alert">{error}</p> : null}
      {effective && (
        <div className="cfg-card">
          <dl className="cfg-facts">
            <div>
              <dt>Running</dt>
              <dd>
                profile {effective.running.profile} · overlay v
                {effective.bootedOverlayVersion ?? '—'}
              </dd>
            </div>
            <div>
              <dt>Modules</dt>
              <dd>{enabled.join(', ') || 'none'}</dd>
            </div>
            <div>
              <dt>Model</dt>
              <dd>{describeGenerator(effective.running.capabilities.generator)}</dd>
            </div>
            <div>
              <dt>Sign-in</dt>
              <dd>
                {effective.authMode} (from {effective.authModeSource})
              </dd>
            </div>
          </dl>
          <button type="button" className="cfg-button" onClick={() => setEditing(true)}>
            Change setup
          </button>
        </div>
      )}
      {effective && effective.history.length > 0 && (
        <div className="cfg-card">
          <h2>History</h2>
          <ul className="cfg-list">
            {effective.history.map((h) => (
              <li key={h.version}>
                v{h.version} · {h.note ?? 'change'} · {h.createdBy} ·{' '}
                {new Date(h.createdAt).toLocaleString()}
              </li>
            ))}
          </ul>
        </div>
      )}
      {secrets && <SecretsCard list={secrets} onSaved={() => setNonce((n) => n + 1)} />}
    </section>
  );
}

function SecretsCard({ list, onSaved }: { list: SecretList; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const save = async () => {
    try {
      await setupJson(`/api/v1/setup/secrets/${encodeURIComponent(name)}`, {
        method: 'PUT',
        body: JSON.stringify({ value }),
      });
      setValue('');
      setNote(`${name} saved. Restart the API to use it.`);
      onSaved();
    } catch (err) {
      setNote((err as Error).message);
    }
  };
  return (
    <div className="cfg-card">
      <h2>Secrets</h2>
      {!list.available ? (
        <p className="cfg-hint">
          The secret store is off. Set TRIAGEAI_SECRET_KEY (32+ characters) on the API to store
          credentials here; until then use environment variables.
        </p>
      ) : (
        <>
          <p className="cfg-hint">
            Values are encrypted and never shown again. Environment variables take precedence.
          </p>
          <ul className="cfg-list">
            {list.secrets.map((s) => (
              <li key={s.name}>
                <code>{s.name}</code> · set by {s.updatedBy} ·{' '}
                {new Date(s.updatedAt).toLocaleString()}
              </li>
            ))}
          </ul>
          <div className="cfg-inline">
            <label className="cfg-field">
              <span>Name (env var, e.g. GITHUB_TOKEN)</span>
              <input value={name} onChange={(e) => setName(e.target.value.toUpperCase())} />
            </label>
            <label className="cfg-field">
              <span>Value</span>
              <input
                type="password"
                autoComplete="off"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="cfg-button"
              disabled={!name || !value}
              onClick={() => void save()}
            >
              Save secret
            </button>
          </div>
          {note ? <p aria-live="polite">{note}</p> : null}
        </>
      )}
    </div>
  );
}

function describeGenerator(generator: unknown): string {
  if (!generator || typeof generator !== 'object') return 'none';
  const g = generator as { adapter?: string; model?: string };
  return `${g.model ?? '?'} via ${g.adapter ?? '?'}`;
}

/**
 * Turn the running config back into wizard answers, so "Change setup" starts
 * from what is actually running rather than from the shipped defaults.
 * Documents and credentials are not reconstructible and start empty.
 */
function answersFromEffective(effective: Effective): SetupAnswers {
  const modules = effective.running.modules;
  const enabled = (id: string) => modules[id]?.enabled === true;
  const interfaces: SetupAnswers['interfaces'] = [];
  if (enabled('chat')) interfaces.push('chatbot');
  if (enabled('support')) interfaces.push('ticket-solver');
  if (enabled('doc-assistant')) interfaces.push('doc-assistant');
  if (enabled('integrations-github')) interfaces.push('notifications-github');
  if (enabled('integrations-slack')) interfaces.push('notifications-slack');
  // The wizard needs at least one interface; an empty/core install keeps the default.
  if (interfaces.length === 0) interfaces.push('chatbot');

  const generator = effective.running.capabilities.generator as
    { adapter?: string; baseUrl?: string; model?: string } | undefined;
  const runtime: SetupAnswers['llm']['runtime'] =
    generator?.adapter === 'ollama'
      ? 'ollama'
      : generator?.adapter === 'lmstudio'
        ? 'lmstudio'
        : generator?.adapter === 'openai_compatible_local'
          ? 'openai-compatible'
          : 'none';
  const llm: SetupAnswers['llm'] =
    runtime === 'none'
      ? { runtime: 'none' }
      : { runtime, baseUrl: generator?.baseUrl, model: generator?.model };

  const githubRepo = modules['integrations-github']?.options?.repo;
  return {
    interfaces,
    knowledge: { autoApprove: false, documents: [] },
    llm,
    ticketSolver: { autoReply: enabled('support') && runtime !== 'none' },
    integrations: githubRepo ? { githubRepo } : {},
    access: { authMode: effective.authMode === 'required' ? 'required' : 'disabled' },
  };
}
