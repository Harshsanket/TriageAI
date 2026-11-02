import { useEffect, useRef, useState } from 'react';

import { AGENT_COLORS, PreferencesResponseSchema } from '@triageai/contracts';
import type {
  AppearanceFontSize,
  AppearanceMotion,
  AppearanceTheme,
  KbChunkStrategy,
  KbDataProcessing,
  KbImageExtraction,
  KbPdfExtraction,
  ModelRuntimeDto,
  SetupAnswers,
  SkillListResponse,
  UserSkill,
  SetupStatus,
  UserPreferences,
} from '@triageai/contracts';

import './config.css';
import { applyAppearance, cacheAppearance } from '../host/appearance';
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
    overlay?: Record<string, unknown>;
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

const SETUP_INTERFACES = [
  'chatbot',
  'ticket-solver',
  'doc-assistant',
  'notifications-github',
  'notifications-slack',
  'emailer',
  'public-api',
] as const;

const CHUNK_STRATEGIES: Array<{
  id: KbChunkStrategy;
  label: string;
  detail: string;
  bestFor: string;
}> = [
  {
    id: 'structure-700',
    label: 'Structure-aware · 700 chars',
    detail:
      'Splits on Markdown headings and keeps lists, tables and code blocks with their section.',
    bestFor: 'Mixed documents, runbooks and policy pages.',
  },
  {
    id: 'structure-1200',
    label: 'Structure-aware · 1,200 chars',
    detail: 'The same section boundaries with larger chunks and more surrounding context.',
    bestFor: 'Long manuals and narrative documentation.',
  },
  {
    id: 'sentence-500',
    label: 'Sentence · 500 chars',
    detail: 'Packs whole sentences into smaller chunks without cutting mid-sentence.',
    bestFor: 'FAQ, Q&A and precise fact lookups.',
  },
  {
    id: 'fixed-1000',
    label: 'Fixed window · 1,000 chars',
    detail: 'Ignores document structure and cuts fixed windows with a 150-character overlap.',
    bestFor: 'Transcripts, logs and unstructured text.',
  },
];

const PDF_EXTRACTIONS: Array<{
  id: KbPdfExtraction;
  label: string;
  detail: string;
  bestFor: string;
  available: boolean;
}> = [
  {
    id: 'text-layer',
    label: 'Text layer (recommended)',
    detail: 'Reads the text embedded in the PDF without OCR.',
    bestFor: 'Digital PDFs; fast and deterministic.',
    available: true,
  },
  {
    id: 'text-layer-strict',
    label: 'Text layer, reject scans',
    detail: 'Uses the text layer but fails a PDF that has no extractable text.',
    bestFor: 'Catching scanned files instead of indexing nothing.',
    available: true,
  },
  {
    id: 'ocr',
    label: 'OCR',
    detail: 'Renders pages and recognises characters; needs the optional AI service OCR adapter.',
    bestFor: 'Scanned PDFs and screenshots.',
    available: false,
  },
];

const IMAGE_EXTRACTIONS: Array<{
  id: KbImageExtraction;
  label: string;
  detail: string;
  bestFor: string;
  available: boolean;
}> = [
  {
    id: 'skip',
    label: 'Skip images',
    detail: 'Stores the image but does not index any text from it.',
    bestFor: 'Decorative images and diagrams.',
    available: true,
  },
  {
    id: 'metadata',
    label: 'Filename + metadata',
    detail: 'Indexes the source title and media type only.',
    bestFor: 'Image libraries with descriptive filenames.',
    available: true,
  },
  {
    id: 'ocr',
    label: 'OCR',
    detail: 'Extracts text from the image; needs the optional AI service OCR adapter.',
    bestFor: 'Screenshots and scanned photos.',
    available: false,
  },
];

interface DataPolicyOverride {
  retentionDays?: number | null;
  modelUse?: string;
  sensitivity?: string;
  archiveBeforeDelete?: boolean;
}

interface DataPolicy {
  classes: Array<{
    id: string;
    sensitivity: string;
    modelUse: string;
    retention: { mode: string; days?: number };
    effective?: {
      retentionDays: number | null;
      modelUse: string;
      sensitivity: string;
      archiveBeforeDelete: boolean;
    };
    custom?: boolean;
  }>;
  overrides?: Record<string, DataPolicyOverride>;
  presets?: string[];
  activePreset?: string | null;
  version?: number;
  sendGate: { sent: number; redacted: number; withheld: number };
}

interface ModelSettings {
  generator: {
    adapter: 'ollama' | 'lmstudio' | 'openai_compatible_local';
    model: string;
    baseUrl: string;
    temperature: number;
    maxTokens: number;
    timeoutMs: number;
  };
  chat: { maxAnswerTokens: number; knowledgeMode: 'prefer' | 'only' };
  retriever: { threshold: number; margin: number };
  overlayVersion: number | null;
  restartRequired: boolean;
}

interface SecretList {
  available: boolean;
  secrets: Array<{
    name: string;
    updatedBy: string;
    updatedAt: string;
    lastUsedAt: string | null;
  }>;
}

function SettingsView({ status, refresh }: { status: SetupStatus; refresh: () => void }) {
  const [effective, setEffective] = useState<Effective | null>(null);
  const [secrets, setSecrets] = useState<SecretList | null>(null);
  const [dataPolicy, setDataPolicy] = useState<DataPolicy | null>(null);
  const [dataProcessing, setDataProcessing] = useState<KbDataProcessing | null>(null);
  const [models, setModels] = useState<ModelSettings | null>(null);
  const [modelNote, setModelNote] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [dangerConfirm, setDangerConfirm] = useState('');
  const [eraseConfirm, setEraseConfirm] = useState('');
  const [dangerNote, setDangerNote] = useState<string | null>(null);
  const [addInterfaces, setAddInterfaces] = useState<string[]>([]);
  const [deleteMode, setDeleteMode] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [lifecycleNote, setLifecycleNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [editing, setEditing] = useState(false);
  const [memoryNote, setMemoryNote] = useState<string | null>(null);

  useEffect(() => {
    setupJson<Effective>('/api/v1/setup/config/effective').then(setEffective, (e: Error) =>
      setError(e.message),
    );
    setupJson<SecretList>('/api/v1/setup/secrets').then(setSecrets, () => undefined);
    setupJson<DataPolicy>('/api/v1/system/data-policy').then(setDataPolicy, () => undefined);
    setupJson<KbDataProcessing>('/api/v1/system/data-processing').then(
      setDataProcessing,
      () => undefined,
    );
    setupJson<ModelSettings>('/api/v1/setup/model-settings').then(
      (data) => {
        if (data.generator && data.chat && data.retriever) setModels(data);
      },
      () => undefined,
    );
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
  const currentAnswers = effective ? answersFromEffective(effective) : null;
  const currentInterfaces = currentAnswers?.interfaces ?? [];
  const setChoice = (value: string, list: string[], set: (next: string[]) => void) =>
    set(list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);
  const removeOne = (value: string) => {
    setDeleting(value);
    setLifecycleNote(null);
    void setupJson('/api/v1/setup/remove', {
      method: 'POST',
      body: JSON.stringify({ interfaces: [value] }),
    }).then(
      () => {
        setLifecycleNote(`Removed ${value}.`);
        setDeleteMode(false);
        setDeleting(null);
        setNonce((n) => n + 1);
        refresh();
      },
      (err: Error) => {
        setLifecycleNote(err.message);
        setDeleting(null);
      },
    );
  };

  return (
    <section className="cfg-wizard" aria-labelledby="cfg-settings">
      <header className="cfg-wizard__head">
        <p className="cfg-eyebrow">Configuration</p>
        <h1 id="cfg-settings">Setup</h1>
        <button
          type="button"
          className="cfg-button"
          onClick={() => {
            setMemoryNote(null);
            setupJson('/api/v1/system/base-memory/refresh', { method: 'POST' }).then(
              () => setMemoryNote('Base memory refreshed from the running config.'),
              (err: Error) => setMemoryNote(err.message),
            );
          }}
        >
          Refresh base memory
        </button>
      </header>
      {memoryNote ? (
        <p className="cfg-hint" role="status">
          {memoryNote}
        </p>
      ) : null}
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
      <AppearanceCard />
      {effective && (
        <div className="cfg-card">
          <h2>Modules</h2>
          <p className="cfg-hint">
            Switch an interface on to add it. Switch an enabled one off, or use Remove interfaces,
            to show the delete icons. Adding applies with a soft reload and keeps every existing
            answer; removing disables its modules but keeps the data.
          </p>
          <div className="cfg-switch-list">
            {SETUP_INTERFACES.map((value) => {
              const isEnabled = currentInterfaces.includes(value);
              const willBeAdded = addInterfaces.includes(value);
              const checked = isEnabled || willBeAdded;
              const state = willBeAdded ? 'will be added' : isEnabled ? 'enabled' : 'disabled';
              return (
                <label key={value} className="cfg-switch-row">
                  <span className="cfg-switch-row__text">
                    <span className="cfg-switch-row__name">{value}</span>
                    <span className="cfg-switch-row__state">{state}</span>
                  </span>
                  {deleteMode ? (
                    <button
                      type="button"
                      className="cfg-delete-button"
                      aria-label={`Delete ${value}`}
                      title={isEnabled ? `Remove ${value}` : `${value} is not enabled`}
                      disabled={!isEnabled || deleting !== null}
                      onClick={() => removeOne(value)}
                    >
                      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
                        <path
                          d="M4 6h12M8 6V4h4v2m-6 0 .7 9.2A1.5 1.5 0 0 0 8.2 16h3.6a1.5 1.5 0 0 0 1.5-1.4L14 6M8.5 9v4M11.5 9v4"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                  ) : (
                    <span className="cfg-switch">
                      <input
                        type="checkbox"
                        role="switch"
                        aria-label={value}
                        checked={checked}
                        onChange={() => {
                          if (isEnabled) {
                            setLifecycleNote(null);
                            setDeleteMode(true);
                          } else {
                            setChoice(value, addInterfaces, setAddInterfaces);
                          }
                        }}
                      />
                      <span className="cfg-switch__track" aria-hidden="true" />
                    </span>
                  )}
                </label>
              );
            })}
          </div>
          <div className="cfg-actions">
            {!deleteMode && (
              <button
                type="button"
                className="cfg-button"
                disabled={addInterfaces.length === 0}
                onClick={() => {
                  setLifecycleNote(null);
                  void setupJson('/api/v1/setup/add', {
                    method: 'POST',
                    body: JSON.stringify({ interfaces: addInterfaces }),
                  }).then(
                    () => {
                      setLifecycleNote(`Added ${addInterfaces.join(', ')}.`);
                      setAddInterfaces([]);
                      setNonce((n) => n + 1);
                      refresh();
                    },
                    (err: Error) => setLifecycleNote(err.message),
                  );
                }}
              >
                Add to setup
              </button>
            )}
            {deleteMode ? (
              <button
                type="button"
                className="cfg-button cfg-button--ghost"
                disabled={deleting !== null}
                onClick={() => {
                  setDeleteMode(false);
                  setLifecycleNote(null);
                }}
              >
                Cancel
              </button>
            ) : (
              <button
                type="button"
                className="cfg-button cfg-button--danger"
                onClick={() => {
                  setLifecycleNote(null);
                  setDeleteMode(true);
                }}
              >
                Remove interfaces
              </button>
            )}
          </div>
          {lifecycleNote ? <p aria-live="polite">{lifecycleNote}</p> : null}
        </div>
      )}
      {models && (
        <div className="cfg-card">
          <h2>Models</h2>
          <p className="cfg-hint">
            Runtime and generation limits. Changes are written as a new config overlay version and
            take effect after the API restarts.
          </p>
          <div className="cfg-inline">
            <label className="cfg-field">
              <span>Runtime</span>
              <select
                value={models.generator.adapter}
                onChange={(event) =>
                  setModels({
                    ...models,
                    generator: {
                      ...models.generator,
                      adapter: event.target.value as ModelSettings['generator']['adapter'],
                    },
                  })
                }
              >
                <option value="ollama">Ollama</option>
                <option value="lmstudio">LM Studio</option>
                <option value="openai_compatible_local">OpenAI-compatible</option>
              </select>
            </label>
            <label className="cfg-field">
              <span>Model</span>
              <input
                value={models.generator.model}
                onChange={(event) =>
                  setModels({
                    ...models,
                    generator: { ...models.generator, model: event.target.value },
                  })
                }
              />
            </label>
            <label className="cfg-field">
              <span>Base URL</span>
              <input
                value={models.generator.baseUrl}
                onChange={(event) =>
                  setModels({
                    ...models,
                    generator: { ...models.generator, baseUrl: event.target.value },
                  })
                }
              />
            </label>
          </div>
          <div className="cfg-inline">
            <label className="cfg-field">
              <span>Temperature</span>
              <input
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={models.generator.temperature}
                onChange={(event) =>
                  setModels({
                    ...models,
                    generator: {
                      ...models.generator,
                      temperature: Number(event.target.value),
                    },
                  })
                }
              />
            </label>
            <label className="cfg-field">
              <span>Max answer tokens</span>
              <input
                type="number"
                min={32}
                max={2048}
                value={models.chat.maxAnswerTokens}
                onChange={(event) =>
                  setModels({
                    ...models,
                    chat: {
                      ...models.chat,
                      maxAnswerTokens: Number(event.target.value),
                    },
                  })
                }
              />
            </label>
            <label className="cfg-field">
              <span>Knowledge mode</span>
              <select
                value={models.chat.knowledgeMode}
                aria-label="Knowledge mode"
                onChange={(event) =>
                  setModels({
                    ...models,
                    chat: {
                      ...models.chat,
                      knowledgeMode: event.target.value as 'prefer' | 'only',
                    },
                  })
                }
              >
                <option value="prefer">Prefer knowledge (general answers allowed)</option>
                <option value="only">Knowledge only (strict refusal)</option>
              </select>
            </label>
            <label className="cfg-field">
              <span>Timeout (ms)</span>
              <input
                type="number"
                min={1000}
                max={600000}
                step={1000}
                value={models.generator.timeoutMs}
                onChange={(event) =>
                  setModels({
                    ...models,
                    generator: { ...models.generator, timeoutMs: Number(event.target.value) },
                  })
                }
              />
            </label>
          </div>
          <div className="cfg-inline">
            <label className="cfg-field">
              <span>Retrieval threshold</span>
              <input
                type="number"
                min={0}
                max={1}
                step={0.01}
                value={models.retriever.threshold}
                onChange={(event) =>
                  setModels({
                    ...models,
                    retriever: { ...models.retriever, threshold: Number(event.target.value) },
                  })
                }
              />
            </label>
            <label className="cfg-field">
              <span>Retrieval margin</span>
              <input
                type="number"
                min={0}
                max={1}
                step={0.01}
                value={models.retriever.margin}
                onChange={(event) =>
                  setModels({
                    ...models,
                    retriever: { ...models.retriever, margin: Number(event.target.value) },
                  })
                }
              />
            </label>
          </div>
          <div className="cfg-actions">
            <button
              type="button"
              className="cfg-button"
              onClick={() => {
                setModelNote(null);
                void setupJson('/api/v1/setup/model-settings', {
                  method: 'PUT',
                  body: JSON.stringify({
                    generator: {
                      adapter: models.generator.adapter,
                      model: models.generator.model,
                      baseUrl: models.generator.baseUrl || undefined,
                      temperature: models.generator.temperature,
                      maxTokens: models.chat.maxAnswerTokens,
                      timeoutMs: models.generator.timeoutMs,
                    },
                    chat: {
                      maxAnswerTokens: models.chat.maxAnswerTokens,
                      knowledgeMode: models.chat.knowledgeMode,
                    },
                    retriever: models.retriever,
                  }),
                }).then(
                  () => {
                    setModelNote('Saved. Restart the API to use the new model settings.');
                    setNonce((n) => n + 1);
                  },
                  (err: Error) => setModelNote(err.message),
                );
              }}
            >
              Save model settings
            </button>
            <button
              type="button"
              className="cfg-button cfg-button--ghost"
              disabled={restarting}
              onClick={() => {
                setModelNote(null);
                setRestarting(true);
                void setupJson('/api/v1/setup/restart', { method: 'POST' }).then(
                  () => {
                    setRestarting(false);
                    setModelNote('Restart requested. The API is restarting…');
                    setNonce((n) => n + 1);
                  },
                  (err: Error) => {
                    setRestarting(false);
                    setModelNote(err.message);
                  },
                );
              }}
            >
              {restarting ? 'Restarting…' : 'Restart API'}
            </button>
          </div>
          {modelNote ? <p aria-live="polite">{modelNote}</p> : null}
        </div>
      )}
      <ModelRuntimePanel />
      {dataProcessing ? (
        <DataProcessingCard data={dataProcessing} onSaved={() => setNonce((n) => n + 1)} />
      ) : null}
      {dataPolicy && <DataPolicyCard data={dataPolicy} onSaved={() => setNonce((n) => n + 1)} />}
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
      <DashboardSettingsCard />
      <ConnectionsCard />
      <SkillsSettingsCard />
      <div className="cfg-card cfg-danger">
        <h2>Danger zone</h2>
        <p>
          Reset all wizard answers to the shipped defaults. Data is kept. This writes a new empty
          config overlay and requires an API restart.
        </p>
        <div className="cfg-inline">
          <label className="cfg-field">
            <span>Type RESET to confirm</span>
            <input
              value={dangerConfirm}
              onChange={(event) => setDangerConfirm(event.target.value)}
              aria-label="type RESET to confirm"
            />
          </label>
          <button
            type="button"
            className="cfg-button cfg-button--danger"
            disabled={dangerConfirm !== 'RESET'}
            onClick={() => {
              setDangerNote(null);
              void setupJson('/api/v1/setup/reset', {
                method: 'POST',
                body: JSON.stringify({ confirm: 'RESET' }),
              }).then(
                () => {
                  setDangerNote('Configuration reset saved. Restart the API to apply defaults.');
                  setDangerConfirm('');
                  setNonce((n) => n + 1);
                },
                (err: Error) => setDangerNote(err.message),
              );
            }}
          >
            Reset configuration
          </button>
        </div>
        <p>
          Reset and erase also uninstalls every module, drops its tables, deletes knowledge sources,
          blobs, datasets and secrets. Users and the audit log are kept. The next boot prints a
          fresh setup token.
        </p>
        <div className="cfg-inline">
          <label className="cfg-field">
            <span>Type TriageAI to confirm erase</span>
            <input
              value={eraseConfirm}
              onChange={(event) => setEraseConfirm(event.target.value)}
              aria-label="type TriageAI to confirm erase"
            />
          </label>
          <button
            type="button"
            className="cfg-button cfg-button--danger"
            disabled={eraseConfirm !== 'TriageAI'}
            onClick={() => {
              setDangerNote(null);
              void setupJson('/api/v1/setup/erase', {
                method: 'POST',
                body: JSON.stringify({ confirm: 'TriageAI' }),
              }).then(
                () => {
                  setDangerNote(
                    'Setup erased. Restart the API; the fresh setup token is printed on boot.',
                  );
                  setEraseConfirm('');
                  setNonce((n) => n + 1);
                },
                (err: Error) => setDangerNote(err.message),
              );
            }}
          >
            Reset and erase
          </button>
        </div>
        {dangerNote ? <p aria-live="polite">{dangerNote}</p> : null}
      </div>
      <AboutCard />
    </section>
  );
}

interface UpdateInfo {
  currentVersion: string;
  latestVersion: string | null;
  available: boolean;
  checkedAt: string | null;
  releaseUrl: string | null;
  stagedPath: string | null;
  canApply: boolean;
  error: string | null;
}

function AboutCard() {
  const version = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '1.0.0';
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updateNote, setUpdateNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void setupJson<UpdateInfo>('/api/v1/system/update').then(setUpdate, () => undefined);
  }, []);
  const post = async (path: string, fallback: string) => {
    setBusy(true);
    setUpdateNote(null);
    try {
      const next = await setupJson<
        UpdateInfo | { applied: boolean; canApply: boolean; message: string }
      >(`/api/v1/system/update/${path}`, { method: 'POST' });
      if ('message' in next) setUpdateNote(next.message);
      else setUpdate(next);
    } catch (err) {
      setUpdateNote((err as Error).message || fallback);
    } finally {
      setBusy(false);
    }
  };
  const action = update?.available
    ? update.stagedPath
      ? update.canApply
        ? 'apply'
        : 'staged'
      : 'download'
    : 'check';
  const label =
    action === 'apply'
      ? 'Update now'
      : action === 'download'
        ? 'Download update'
        : action === 'staged'
          ? 'Downloaded'
          : 'Check update';
  return (
    <div className="cfg-card cfg-about">
      <h2>TriageAI</h2>
      <p className="cfg-about__version">Version {version}</p>
      <p>
        A modular, self-hosted AI automation platform. Build, integrate, and orchestrate agents your
        way.
      </p>
      <p className="cfg-about__made">Made proudly in Mumbai by Harsh Sanket</p>
      <div className="cfg-about__links">
        <a
          href="https://github.com/Harshsanket/TriageAI"
          target="_blank"
          rel="noreferrer noopener"
          aria-label="Star TriageAI on GitHub"
          title="Star it on GitHub"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path
              d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.35 1.09 2.92.83.09-.65.35-1.09.63-1.34-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.03A9.6 9.6 0 0 1 12 6.8c.85 0 1.7.11 2.5.33 1.9-1.3 2.74-1.03 2.74-1.03.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2Z"
              fill="currentColor"
            />
          </svg>
          Star it on GitHub
        </a>
        <a
          href="https://github.com/Harshsanket/TriageAI/issues/new"
          target="_blank"
          rel="noreferrer noopener"
          aria-label="Report a bug"
          title="Report bugs"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path
              d="M8 8h8v8a4 4 0 0 1-8 0V8Zm-2 3h2m8 0h2M6 15h2m8 0h2M9 5l1.5 2M15 5l-1.5 2M12 4v2"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
          Report bugs
        </a>
      </div>
      <div className="cfg-about__update">
        <button
          type="button"
          className="cfg-button"
          disabled={busy || action === 'staged'}
          onClick={() =>
            void post(
              action === 'check' ? 'check' : action === 'download' ? 'download' : 'apply',
              'Update failed.',
            )
          }
        >
          {busy ? 'Working…' : label}
        </button>
        <div className="cfg-about__update-meta">
          <p className="cfg-about__update-state" aria-live="polite">
            {update?.error
              ? `Update check failed: ${update.error}`
              : update?.available
                ? `Update ${update.latestVersion} available`
                : update
                  ? 'Up to date'
                  : 'Update status unavailable.'}
          </p>
          {update?.available && update.releaseUrl ? (
            <a href={update.releaseUrl} target="_blank" rel="noreferrer noopener">
              Release notes
            </a>
          ) : null}
        </div>
      </div>
      {updateNote ? <p aria-live="polite">{updateNote}</p> : null}
      <p className="cfg-about__credit">
        a <strong>Harsh Sanket</strong> production
      </p>
    </div>
  );
}

export function Toggle({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`cfg-toggle${checked ? ' cfg-toggle--on' : ''}`}
      onClick={onChange}
    >
      <span aria-hidden="true" />
    </button>
  );
}

export function ModelRuntimePanel() {
  const [state, setState] = useState<{
    runtimes: ModelRuntimeDto[];
    controls: { llmDisabled: boolean; disabledRuntimes: string[] };
  } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    setupJson<{
      runtimes: ModelRuntimeDto[];
      controls: { llmDisabled: boolean; disabledRuntimes: string[] };
    }>('/api/v1/system/model-runtimes').then(setState, (err: Error) => setNote(err.message));

  useEffect(() => {
    void load();
  }, []);

  const update = async (patch: Record<string, unknown>) => {
    setBusy(true);
    setNote(null);
    try {
      await setupJson('/api/v1/system/controls', {
        method: 'PUT',
        body: JSON.stringify(patch),
      });
      await load();
      setNote('Switch updated. It applies without a restart.');
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!state) {
    return (
      <div className="cfg-card">
        <h2>Model runtimes</h2>
        <p className="cfg-hint">{note ?? 'Loading runtimes…'}</p>
      </div>
    );
  }
  const controls = state.controls ?? { llmDisabled: false, disabledRuntimes: [] };
  const runtimes = Array.isArray(state.runtimes) ? state.runtimes : [];
  const disabled = new Set(controls.disabledRuntimes ?? []);
  return (
    <div className="cfg-card">
      <h2>Model runtimes</h2>
      <p className="cfg-hint">
        Every configured LLM and the features it serves. Switches are hot; changing the model or
        endpoint still needs a restart. A disabled runtime is never selected.
      </p>
      <label className="cfg-switch-row">
        <span className="cfg-switch-row__text">
          <span className="cfg-switch-row__name">Turn off all LLMs</span>
          <span className="cfg-switch-row__state">
            {controls.llmDisabled ? 'generation is off' : 'generation is on'}
          </span>
        </span>
        <Toggle
          label="Turn off all LLMs"
          checked={controls.llmDisabled}
          disabled={busy}
          onChange={() => void update({ llmDisabled: !controls.llmDisabled })}
        />
      </label>
      {runtimes.length === 0 ? (
        <p className="cfg-hint">No model runtime is configured.</p>
      ) : (
        <div className="cfg-switch-list">
          {runtimes.map((runtime) => {
            const off = controls.llmDisabled || disabled.has(runtime.id);
            return (
              <label key={runtime.id} className="cfg-switch-row">
                <span className="cfg-switch-row__text">
                  <span className="cfg-switch-row__name">
                    {runtime.model || runtime.id}
                    {runtime.hosted ? ' (hosted)' : ' (local)'}
                  </span>
                  <span className="cfg-switch-row__state">
                    {runtime.id} · {off ? 'disabled' : runtime.status} ·{' '}
                    {runtime.features.join(', ')}
                    {runtime.contextWindow ? ` · ${runtime.contextWindow} ctx` : ''}
                  </span>
                </span>
                <Toggle
                  label={`${runtime.id} enabled`}
                  checked={!off}
                  disabled={busy || controls.llmDisabled}
                  onChange={() => {
                    const next = new Set(controls.disabledRuntimes);
                    if (next.has(runtime.id)) next.delete(runtime.id);
                    else next.add(runtime.id);
                    const allDisabled =
                      runtimes.length > 0 && runtimes.every((entry) => next.has(entry.id));
                    void update({
                      disabledRuntimes: [...next],
                      ...(allDisabled ? { llmDisabled: true } : {}),
                    });
                  }}
                />
              </label>
            );
          })}
        </div>
      )}
      {note ? <p aria-live="polite">{note}</p> : null}
    </div>
  );
}

function DataProcessingCard({ data, onSaved }: { data: KbDataProcessing; onSaved: () => void }) {
  const [draft, setDraft] = useState(data);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => setDraft(data), [data]);
  const update = <K extends keyof KbDataProcessing>(key: K, value: KbDataProcessing[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const save = async () => {
    try {
      const saved = await setupJson<KbDataProcessing>('/api/v1/system/data-processing', {
        method: 'PUT',
        body: JSON.stringify(draft),
      });
      setDraft(saved);
      setNote('Saved. New sources use these settings; re-ingest a source to apply them to it.');
      onSaved();
    } catch (err) {
      setNote((err as Error).message);
    }
  };
  return (
    <div className="cfg-card">
      <h2>Data processing</h2>
      <p className="cfg-hint">
        How new knowledge sources are extracted and chunked. Existing sources keep the method they
        were ingested with; re-ingest a source to apply a new choice.
      </p>
      <div className="cfg-processing-grid">
        <label className="cfg-field">
          <span>Chunking strategy</span>
          <select
            aria-label="Chunking strategy"
            value={draft.chunking}
            onChange={(event) => update('chunking', event.target.value as KbChunkStrategy)}
          >
            {CHUNK_STRATEGIES.map((strategy) => (
              <option key={strategy.id} value={strategy.id}>
                {strategy.label}
              </option>
            ))}
          </select>
        </label>
        <label className="cfg-field">
          <span>PDF extraction</span>
          <select
            aria-label="PDF extraction"
            value={draft.pdfExtraction}
            onChange={(event) => update('pdfExtraction', event.target.value as KbPdfExtraction)}
          >
            {PDF_EXTRACTIONS.map((option) => (
              <option key={option.id} value={option.id} disabled={!option.available}>
                {option.available ? option.label : `${option.label} (unavailable)`}
              </option>
            ))}
          </select>
        </label>
        <label className="cfg-field">
          <span>Image extraction</span>
          <select
            aria-label="Image extraction"
            value={draft.imageExtraction}
            onChange={(event) => update('imageExtraction', event.target.value as KbImageExtraction)}
          >
            {IMAGE_EXTRACTIONS.map((option) => (
              <option key={option.id} value={option.id} disabled={!option.available}>
                {option.available ? option.label : `${option.label} (unavailable)`}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="cfg-notes">
        <h3>Chunking strategies</h3>
        <ul>
          {CHUNK_STRATEGIES.map((strategy) => (
            <li key={strategy.id}>
              <strong>{strategy.label}</strong> {strategy.detail}{' '}
              <em>Best for: {strategy.bestFor}</em>
            </li>
          ))}
        </ul>
        <h3>Extraction methods</h3>
        <ul>
          {[
            ...PDF_EXTRACTIONS.map((option) => ({ ...option, section: 'PDF' })),
            ...IMAGE_EXTRACTIONS.map((option) => ({ ...option, section: 'Image' })),
          ].map((option) => (
            <li key={`${option.section}-${option.id}`}>
              <strong>
                {option.section}: {option.label}
              </strong>{' '}
              {option.detail} <em>Best for: {option.bestFor}</em>
              {option.available ? null : <span className="cfg-notes__off"> Unavailable here.</span>}
            </li>
          ))}
        </ul>
      </div>
      <div className="cfg-actions">
        <button type="button" className="cfg-button" onClick={() => void save()}>
          Save data processing
        </button>
      </div>
      {note ? <p aria-live="polite">{note}</p> : null}
    </div>
  );
}

function DataPolicyCard({ data, onSaved }: { data: DataPolicy; onSaved: () => void }) {
  const defaults = Object.fromEntries(
    (data.classes ?? []).map((cls) => [
      cls.id,
      {
        retentionDays: cls.effective?.retentionDays ?? cls.retention.days ?? null,
        modelUse: cls.effective?.modelUse ?? cls.modelUse,
        sensitivity: cls.effective?.sensitivity ?? cls.sensitivity,
        archiveBeforeDelete: cls.effective?.archiveBeforeDelete ?? false,
      },
    ]),
  ) as Record<string, DataPolicyOverride>;
  const [overrides, setOverrides] = useState<Record<string, DataPolicyOverride>>(
    data.overrides ?? defaults,
  );
  const [presetName, setPresetName] = useState('');
  const [preset, setPreset] = useState(data.activePreset ?? '');
  const [note, setNote] = useState<string | null>(null);
  const update = (id: string, patch: DataPolicyOverride) =>
    setOverrides((current) => ({ ...current, [id]: { ...current[id], ...patch } }));
  const save = async (extra: Record<string, unknown> = {}) => {
    try {
      await setupJson('/api/v1/system/data-policy', {
        method: 'PUT',
        body: JSON.stringify({ overrides, ...extra }),
      });
      setNote(`Saved policy version ${(data.version ?? 0) + 1}.`);
      onSaved();
    } catch (err) {
      setNote((err as Error).message);
    }
  };
  return (
    <div className="cfg-card">
      <h2>Data policy</h2>
      <p>
        Every store has a class. Overrides must stay inside the class bounds (retention and model
        exposure); secret data can never reach a model.
      </p>
      <div className="cfg-inline">
        <label className="cfg-field">
          <span>Named policy</span>
          <select value={preset} onChange={(event) => setPreset(event.target.value)}>
            <option value="">Defaults</option>
            {(data.presets ?? []).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="cfg-button"
          onClick={() => {
            void setupJson('/api/v1/system/data-policy', {
              method: 'PUT',
              body: JSON.stringify({ applyPreset: preset || null }),
            }).then(
              () => {
                setNote(preset ? `Applied ${preset}.` : 'Reset to defaults.');
                onSaved();
              },
              (err: Error) => setNote(err.message),
            );
          }}
        >
          Apply
        </button>
        <label className="cfg-field">
          <span>Save current as</span>
          <input
            value={presetName}
            placeholder="Strict, Personal finance…"
            onChange={(event) => setPresetName(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="cfg-button cfg-button--ghost"
          disabled={!presetName.trim()}
          onClick={() => void save({ savePreset: presetName.trim() })}
        >
          Save preset
        </button>
        <button
          type="button"
          className="cfg-button cfg-button--ghost"
          onClick={() => void save({ reset: true })}
        >
          Reset
        </button>
      </div>
      <div className="dashboard__table-scroll">
        <table className="dashboard__table">
          <thead>
            <tr>
              <th>Class</th>
              <th>Retention (days)</th>
              <th>Model use</th>
              <th>Sensitivity</th>
              <th>Archive before delete</th>
            </tr>
          </thead>
          <tbody>
            {(data.classes ?? []).map((cls) => {
              const value = overrides[cls.id] ?? defaults[cls.id] ?? {};
              return (
                <tr key={cls.id}>
                  <td>{cls.id}</td>
                  <td>
                    <input
                      type="number"
                      min={1}
                      max={3650}
                      aria-label={`${cls.id} retention days`}
                      value={String(value.retentionDays ?? '')}
                      onChange={(event) =>
                        update(cls.id, { retentionDays: Number(event.target.value) })
                      }
                    />
                  </td>
                  <td>
                    <select
                      aria-label={`${cls.id} model use`}
                      value={value.modelUse ?? 'never'}
                      onChange={(event) => update(cls.id, { modelUse: event.target.value })}
                    >
                      {['never', 'local_only', 'redacted', 'allowed'].map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select
                      aria-label={`${cls.id} sensitivity`}
                      value={value.sensitivity ?? 'internal'}
                      onChange={(event) => update(cls.id, { sensitivity: event.target.value })}
                    >
                      {['public', 'internal', 'restricted', 'secret'].map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`${cls.id} archive before delete`}
                      checked={Boolean(value.archiveBeforeDelete)}
                      onChange={(event) =>
                        update(cls.id, { archiveBeforeDelete: event.target.checked })
                      }
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="cfg-actions">
        <button type="button" className="cfg-button" onClick={() => void save()}>
          Save data policy
        </button>
      </div>
      {note ? <p aria-live="polite">{note}</p> : null}
      <p className="cfg-muted">
        Send gate: {data.sendGate?.sent ?? 0} sent · {data.sendGate?.redacted ?? 0} redacted ·{' '}
        {data.sendGate?.withheld ?? 0} withheld
      </p>
    </div>
  );
}

interface ConnectionView {
  id: string;
  name: string;
  type: string;
  baseUrl: string | null;
  secretName: string | null;
  source: 'config' | 'custom';
  status: string;
  allowlisted: boolean;
  actions: string[];
}

interface SkillSourcesResponse {
  sources: Array<{
    name: string;
    repo: string;
    url: string;
    license: string;
    status: string;
    pinned: Array<{ name: string; version: number; ref: string | null }>;
  }>;
}

export function SkillsSettingsCard() {
  const [data, setData] = useState<SkillListResponse | null>(null);
  const [sources, setSources] = useState<SkillSourcesResponse | null>(null);
  const [url, setUrl] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [tab, setTab] = useState<'list' | 'add'>('list');

  const load = () => {
    setupJson<SkillListResponse>('/api/v1/skills').then(setData, (err: Error) =>
      setNote(err.message),
    );
    setupJson<SkillSourcesResponse>('/api/v1/skills/sources').then(setSources, () => undefined);
  };
  useEffect(() => {
    void load();
  }, []);

  const toggle = async (skill: UserSkill) => {
    await setupJson(`/api/v1/skills/${skill.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: !skill.enabled }),
    });
    setNote(`${skill.name} is now ${skill.enabled ? 'off' : 'on'}.`);
    await load();
  };

  const removeSkill = async (skill: UserSkill) => {
    if (!globalThis.confirm?.(`Delete the skill “${skill.name}”?`)) return;
    try {
      await setupJson(`/api/v1/skills/${skill.id}`, { method: 'DELETE' });
      setNote(`${skill.name} deleted.`);
      await load();
    } catch (err) {
      setNote((err as Error).message);
    }
  };

  const importSkill = async () => {
    try {
      await setupJson('/api/v1/skills/import', {
        method: 'POST',
        body: JSON.stringify({ url: url.trim() }),
      });
      setUrl('');
      setNote('Imported. Enable it below to use it.');
      await load();
    } catch (err) {
      setNote((err as Error).message);
    }
  };

  const skills = Array.isArray(data?.skills) ? data.skills : [];
  const sourceList = Array.isArray(sources?.sources) ? sources.sources : [];
  return (
    <div className="cfg-card">
      <h2>Skills</h2>
      <p className="cfg-hint">
        Content-only instructions shared with chat. Imported GitHub content is untrusted until you
        enable it; nothing is executed.
      </p>
      <div className="cfg-tabs" role="tablist" aria-label="Skills sections">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'list'}
          className={tab === 'list' ? 'cfg-tab cfg-tab--active' : 'cfg-tab'}
          onClick={() => setTab('list')}
        >
          List of skills
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'add'}
          className={tab === 'add' ? 'cfg-tab cfg-tab--active' : 'cfg-tab'}
          onClick={() => setTab('add')}
        >
          Add skills
        </button>
      </div>
      {tab === 'list' ? (
        <section aria-label="List of skills">
          {skills.length > 0 ? (
            <div className="cfg-switch-list">
              {skills.map((skill) => (
                <div key={skill.id} className="cfg-switch-row">
                  <span className="cfg-switch-row__text">
                    <span className="cfg-switch-row__name">{skill.name}</span>
                    <span className="cfg-switch-row__state">
                      v{skill.version} · {skill.provenance} · {skill.scope} ·{' '}
                      {skill.enabled ? 'on' : 'off'}
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={`${skill.name} enabled`}
                    checked={skill.enabled}
                    onChange={() => void toggle(skill)}
                  />
                  <button
                    type="button"
                    className="cfg-button cfg-button--danger"
                    aria-label={`Delete ${skill.name}`}
                    onClick={() => void removeSkill(skill)}
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="cfg-hint">No user skills yet. Add one under “Add skills”.</p>
          )}
        </section>
      ) : (
        <section aria-label="Add skills">
          <h3>Default sources</h3>
          <ul className="cfg-list">
            {sourceList.map((source) => (
              <li key={source.repo}>
                {source.name} · {source.repo} · {source.status}
                {source.pinned.length > 0
                  ? ` · pinned ${source.pinned.map((pin) => `${pin.name} v${pin.version}`).join(', ')}`
                  : ''}
              </li>
            ))}
          </ul>
          <div className="cfg-inline">
            <label className="cfg-field">
              <span>Add from GitHub</span>
              <input
                value={url}
                placeholder="https://github.com/owner/repo/blob/main/SKILL.md"
                onChange={(event) => setUrl(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="cfg-button"
              disabled={!url.trim()}
              onClick={() => void importSkill()}
            >
              Import
            </button>
          </div>
        </section>
      )}
      {note ? <p aria-live="polite">{note}</p> : null}
    </div>
  );
}

function DashboardSettingsCard() {
  const [refreshMs, setRefreshMs] = useState(600_000);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    void setupJson<{ refreshMs: number }>('/api/v1/system/dashboard-settings').then(
      (body) => setRefreshMs(body.refreshMs || 600_000),
      () => undefined,
    );
  }, []);
  return (
    <div className="cfg-card">
      <h2>Dashboard</h2>
      <p>How often the dashboard refreshes its metrics. Default is every 10 minutes.</p>
      <div className="cfg-inline">
        <label className="cfg-field">
          <span>Refresh frequency</span>
          <select
            aria-label="Dashboard refresh frequency"
            value={refreshMs}
            onChange={(event) => setRefreshMs(Number(event.target.value))}
          >
            <option value={60_000}>Every minute</option>
            <option value={300_000}>Every 5 minutes</option>
            <option value={600_000}>Every 10 minutes (default)</option>
            <option value={1_800_000}>Every 30 minutes</option>
          </select>
        </label>
        <button
          type="button"
          className="cfg-button"
          onClick={() => {
            void setupJson('/api/v1/system/dashboard-settings', {
              method: 'PUT',
              body: JSON.stringify({ refreshMs }),
            }).then(
              () => setNote('Saved. The dashboard picks this up on its next load.'),
              (err: Error) => setNote(err.message),
            );
          }}
        >
          Save
        </button>
      </div>
      {note ? <p aria-live="polite">{note}</p> : null}
    </div>
  );
}

function ConnectionsCard() {
  const [connections, setConnections] = useState<ConnectionView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [draft, setDraft] = useState({
    name: '',
    type: 'custom',
    baseUrl: '',
    secretName: '',
    secretValue: '',
    allowHost: false,
  });
  const load = () => {
    void setupJson<{ connections?: ConnectionView[] }>('/api/v1/connections').then(
      (body) => setConnections(Array.isArray(body.connections) ? body.connections : []),
      (err: Error) => setError(err.message),
    );
  };
  useEffect(load, []);
  const create = async () => {
    setError(null);
    try {
      await setupJson('/api/v1/connections', {
        method: 'POST',
        body: JSON.stringify({
          name: draft.name,
          type: draft.type,
          baseUrl: draft.baseUrl,
          ...(draft.secretName ? { secretName: draft.secretName } : {}),
          ...(draft.secretValue ? { secretValue: draft.secretValue } : {}),
          allowHost: draft.allowHost,
        }),
      });
      setDraft({
        name: '',
        type: 'custom',
        baseUrl: '',
        secretName: '',
        secretValue: '',
        allowHost: false,
      });
      setNote('Connection saved.');
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const act = async (connection: ConnectionView, action: string) => {
    setError(null);
    try {
      if (action === 'test') {
        const result = await setupJson<{ ok: boolean; status: number | null; latencyMs: number }>(
          `/api/v1/connections/${connection.id}/test`,
          { method: 'POST' },
        );
        setNote(
          result.ok
            ? `${connection.name}: ${result.status ?? 200} in ${result.latencyMs} ms`
            : `${connection.name}: unreachable`,
        );
        return;
      }
      if (action === 'rotate') {
        const value = globalThis.prompt?.(`New value for ${connection.secretName}`);
        if (!value) return;
        await setupJson(`/api/v1/connections/${connection.id}/secret`, {
          method: 'PUT',
          body: JSON.stringify({ value }),
        });
        setNote('Secret rotated; restart the API to use it.');
        return;
      }
      if (action === 'disable') {
        await setupJson(`/api/v1/connections/${connection.id}/disable`, { method: 'POST' });
      } else if (action === 'remove') {
        if (!globalThis.confirm?.(`Remove ${connection.name}?`)) return;
        await setupJson(`/api/v1/connections/${connection.id}`, { method: 'DELETE' });
      }
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div className="cfg-card">
      <h2>Connected APIs</h2>
      <p>
        Every external API in one list. Secrets are write-only; values stay in the encrypted store.
      </p>
      {connections.length === 0 ? (
        <p className="cfg-muted">No connections configured.</p>
      ) : (
        <ul className="cfg-list">
          {connections.map((connection) => (
            <li key={connection.id}>
              <strong>{connection.name}</strong> · {connection.type} · {connection.status}
              {connection.baseUrl ? ` · ${connection.baseUrl}` : ''}
              {connection.secretName ? ` · secret ${connection.secretName}` : ''}
              {connection.source === 'config' ? ' · config' : ''}
              <span className="cfg-inline">
                <button
                  type="button"
                  className="cfg-link"
                  onClick={() => void act(connection, 'test')}
                >
                  Test
                </button>
                {connection.actions.includes('rotate') && (
                  <button
                    type="button"
                    className="cfg-link"
                    onClick={() => void act(connection, 'rotate')}
                  >
                    Rotate
                  </button>
                )}
                {connection.actions.includes('disable') && (
                  <button
                    type="button"
                    className="cfg-link"
                    onClick={() => void act(connection, 'disable')}
                  >
                    Disable
                  </button>
                )}
                {connection.actions.includes('remove') && (
                  <button
                    type="button"
                    className="cfg-link"
                    onClick={() => void act(connection, 'remove')}
                  >
                    Remove
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <h3>Add connection</h3>
      <div className="cfg-inline">
        <label className="cfg-field">
          <span>Name</span>
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </label>
        <label className="cfg-field">
          <span>Type</span>
          <select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })}>
            {['hosted-model', 'github', 'slack', 'smtp', 'mcp', 'source-plugin', 'custom'].map(
              (type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ),
            )}
          </select>
        </label>
        <label className="cfg-field">
          <span>Base URL</span>
          <input
            value={draft.baseUrl}
            placeholder="https://api.example.com"
            onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
          />
        </label>
        <label className="cfg-field">
          <span>Secret name</span>
          <input
            value={draft.secretName}
            placeholder="EXAMPLE_API_KEY"
            onChange={(e) => setDraft({ ...draft, secretName: e.target.value.toUpperCase() })}
          />
        </label>
        <label className="cfg-field">
          <span>Secret value</span>
          <input
            type="password"
            value={draft.secretValue}
            onChange={(e) => setDraft({ ...draft, secretValue: e.target.value })}
          />
        </label>
        <label className="cfg-choice">
          <input
            type="checkbox"
            checked={draft.allowHost}
            onChange={(e) => setDraft({ ...draft, allowHost: e.target.checked })}
          />
          <span>Allow this host for tests (egress)</span>
        </label>
        <button
          type="button"
          className="cfg-button"
          disabled={!draft.name || !draft.baseUrl}
          onClick={() => void create()}
        >
          Add
        </button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {note ? <p aria-live="polite">{note}</p> : null}
    </div>
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
          The secret store is off because no key could be read or generated. Set TRIAGEAI_SECRET_KEY
          (32+ characters) or make the secrets volume writable; until then use environment
          variables.
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
                {new Date(s.updatedAt).toLocaleString()} ·{' '}
                {s.lastUsedAt
                  ? `last used ${new Date(s.lastUsedAt).toLocaleString()}`
                  : 'not used since the key was stored'}
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
  const storedInterfaces = Array.isArray(effective.latestOverlay?.overlay?.interfaces)
    ? (effective.latestOverlay?.overlay?.interfaces as string[])
    : null;
  const interfaces: SetupAnswers['interfaces'] = storedInterfaces
    ? (storedInterfaces as SetupAnswers['interfaces'])
    : [];
  if (!storedInterfaces) {
    if (enabled('chat')) interfaces.push('chatbot');
    if (enabled('support')) interfaces.push('ticket-solver');
    if (enabled('doc-assistant')) interfaces.push('doc-assistant');
    if (enabled('integrations-github')) interfaces.push('notifications-github');
    if (enabled('integrations-slack')) interfaces.push('notifications-slack');
    if (enabled('emailer')) interfaces.push('emailer');
    if (enabled('public-api')) interfaces.push('public-api');
  }
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
  const storedAgents = effective.latestOverlay?.overlay?.agents as
    Record<string, { displayName?: string; color?: string }> | undefined;
  const agents = storedAgents
    ? Object.entries(storedAgents)
        .filter(([key]) => interfaces.includes(key as SetupAnswers['interfaces'][number]))
        .map(([key, agent]) => ({
          interface: key,
          displayName: agent.displayName ?? key,
          color: agent.color ?? '#3b6fd4',
        }))
    : [];
  return {
    interfaces,
    agents,
    knowledge: { autoApprove: true, documents: [] },
    llm,
    ticketSolver: { autoReply: enabled('support') && runtime !== 'none' },
    integrations: githubRepo ? { githubRepo } : {},
    access: { authMode: effective.authMode === 'required' ? 'required' : 'disabled' },
  };
}

interface PreferencesBody {
  preferences: UserPreferences;
  defaults: Partial<UserPreferences> | null;
  agents: Array<{ id: string; displayName: string; color: string }>;
}

function AppearanceCard() {
  const [body, setBody] = useState<PreferencesBody | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setupJson<unknown>('/api/v1/me/preferences').then(
      (data) => {
        const parsed = PreferencesResponseSchema.safeParse(data);
        if (parsed.success) setBody(parsed.data as PreferencesBody);
      },
      (err: Error) => setNote(err.message),
    );
  }, []);

  if (!body?.preferences) return null;
  const preferences = body.preferences;
  const update = (patch: Partial<UserPreferences>) =>
    setBody({ ...body, preferences: { ...preferences, ...patch } });
  const updateAgent = (id: string, patch: Partial<{ displayName: string; color: string }>) =>
    update({
      agents: preferences.agents.map((agent) => (agent.id === id ? { ...agent, ...patch } : agent)),
    });

  const save = async () => {
    setSaving(true);
    try {
      const saved = await setupJson<PreferencesBody>('/api/v1/me/preferences', {
        method: 'PUT',
        body: JSON.stringify({
          theme: preferences.theme,
          fontSize: preferences.fontSize,
          motion: preferences.motion,
          agents: preferences.agents,
        }),
      });
      setBody(saved);
      cacheAppearance(saved.preferences);
      applyAppearance(saved.preferences);
      setNote('Appearance saved.');
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const resetToDefault = async () => {
    setSaving(true);
    try {
      const saved = await setupJson<PreferencesBody>('/api/v1/me/preferences', {
        method: 'PUT',
        body: JSON.stringify({
          theme: 'auto',
          fontSize: 'default',
          motion: 'auto',
          agents: preferences.agents,
        }),
      });
      setBody(saved);
      cacheAppearance(saved.preferences);
      applyAppearance(saved.preferences);
      setNote('Appearance reset to default.');
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="cfg-card">
      <h2>Appearance</h2>
      <p className="cfg-hint">These apply to your account immediately.</p>
      <div className="cfg-inline">
        <label className="cfg-field">
          <span>Theme</span>
          <select
            value={preferences.theme}
            onChange={(event) => update({ theme: event.target.value as AppearanceTheme })}
          >
            <option value="light">Light</option>
            <option value="dark">Dark</option>
            <option value="auto">Auto (follow system)</option>
          </select>
        </label>
        <label className="cfg-field">
          <span>Font size</span>
          <select
            value={preferences.fontSize}
            onChange={(event) => update({ fontSize: event.target.value as AppearanceFontSize })}
          >
            <option value="small">Small</option>
            <option value="default">Default</option>
            <option value="large">Large</option>
            <option value="xlarge">Extra large</option>
          </select>
        </label>
        <label className="cfg-field">
          <span>Animations</span>
          <select
            value={preferences.motion}
            onChange={(event) => update({ motion: event.target.value as AppearanceMotion })}
          >
            <option value="on">On</option>
            <option value="off">Off</option>
            <option value="auto">Auto (follow system)</option>
          </select>
        </label>
      </div>
      {preferences.agents.length > 0 && (
        <>
          <h3>Agents</h3>
          <div className="cfg-appearance-agents">
            {preferences.agents.map((agent) => (
              <div key={agent.id} className="cfg-agent-row">
                <span className="cfg-agent-row__interface">{agent.id}</span>
                <label>
                  <span className="cfg-label">Name</span>
                  <input
                    className="cfg-input"
                    maxLength={40}
                    value={agent.displayName}
                    onChange={(event) => updateAgent(agent.id, { displayName: event.target.value })}
                  />
                </label>
                <label>
                  <span className="cfg-label">Colour</span>
                  <select
                    className="cfg-select"
                    value={agent.color}
                    onChange={(event) => updateAgent(agent.id, { color: event.target.value })}
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
          </div>
        </>
      )}
      <div className="cfg-inline">
        <button type="button" className="cfg-button" disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          className="cfg-button cfg-button--ghost"
          disabled={saving}
          onClick={() => void resetToDefault()}
        >
          Reset to default
        </button>
      </div>
      {note ? <p aria-live="polite">{note}</p> : null}
    </div>
  );
}
