/**
 * Chat-surface Skills drawer (ADR-0060): list, On/Off, GitHub import, custom
 * creation, suggestion review and delete. Everything is content-only.
 */
import { useCallback, useEffect, useState } from 'react';

import type { SkillListResponse, UserSkill } from '@triageai/contracts';

import { apiFetch, type ApiFailure } from '../../host/api';
import { Button, ErrorNotice } from '../../ui';

const EMPTY: SkillListResponse = { builtIn: [], skills: [], suggestions: [] };

export function SkillsDrawer({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<SkillListResponse>(EMPTY);
  const [error, setError] = useState<ApiFailure | string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [githubUrl, setGithubUrl] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');

  const load = useCallback(async () => {
    const res = await apiFetch<SkillListResponse>('/api/v1/skills');
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError(null);
    setData(res.data);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const call = async (url: string, init: RequestInit, success: string) => {
    setBusy(true);
    setError(null);
    const res = await apiFetch(url, init);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return false;
    }
    setNote(success);
    await load();
    return true;
  };

  const toggle = (skill: UserSkill) =>
    call(
      `/api/v1/skills/${skill.id}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !skill.enabled }),
      },
      `${skill.name} is now ${skill.enabled ? 'off' : 'on'}.`,
    );

  const remove = (skill: UserSkill) => {
    if (!globalThis.confirm?.(`Delete the skill “${skill.name}”?`)) return;
    void call(`/api/v1/skills/${skill.id}`, { method: 'DELETE' }, `${skill.name} deleted.`);
  };

  const importUrl = () =>
    call(
      '/api/v1/skills/import',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: githubUrl.trim() }),
      },
      'Imported. Enable it below to use it.',
    ).then((ok) => {
      if (ok) setGithubUrl('');
    });

  const create = () =>
    call(
      '/api/v1/skills',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          description: description.trim(),
          instructions: instructions.trim(),
        }),
      },
      'Skill created and enabled.',
    ).then((ok) => {
      if (ok) {
        setDescription('');
        setInstructions('');
      }
    });

  const resolve = (skill: UserSkill, action: 'accept' | 'ignore') =>
    call(
      `/api/v1/skills/${skill.id}/suggestion`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      },
      action === 'accept' ? `${skill.name} saved.` : 'Suggestion ignored.',
    );

  const skills = Array.isArray(data.skills) ? data.skills : [];
  const suggestions = Array.isArray(data.suggestions) ? data.suggestions : [];
  const builtIn = Array.isArray(data.builtIn) ? data.builtIn : [];

  const renderSkill = (skill: UserSkill) => (
    <li key={skill.id} className="skills__row">
      <span className="skills__main">
        <span className="skills__name">
          {skill.name}
          <span className="skills__badge">{skill.provenance}</span>
          {skill.suggestion ? <span className="skills__badge">suggestion</span> : null}
        </span>
        <span className="skills__description">{skill.description}</span>
        <span className="skills__meta">v{skill.version}</span>
      </span>
      <span className="skills__actions">
        {skill.suggestion ? (
          <>
            <Button onClick={() => void resolve(skill, 'accept')}>Save</Button>
            <Button onClick={() => void resolve(skill, 'ignore')}>Ignore</Button>
          </>
        ) : (
          <button
            type="button"
            role="switch"
            aria-checked={skill.enabled}
            aria-label={`${skill.name} enabled`}
            className={`skills__switch${skill.enabled ? ' skills__switch--on' : ''}`}
            onClick={() => void toggle(skill)}
          >
            <span />
          </button>
        )}
        <button
          type="button"
          className="skills__delete"
          aria-label={`Delete ${skill.name}`}
          onClick={() => remove(skill)}
        >
          ×
        </button>
      </span>
    </li>
  );

  return (
    <div className="skills" role="dialog" aria-label="Skills">
      <div className="skills__panel">
        <header className="skills__head">
          <h2>Skills</h2>
          <button type="button" aria-label="Close skills" onClick={onClose}>
            ×
          </button>
        </header>
        {error ? <ErrorNotice error={error} /> : null}
        {note ? (
          <p className="skills__note" role="status">
            {note}
          </p>
        ) : null}
        {suggestions.length > 0 ? (
          <section>
            <h3>Suggested from chat</h3>
            <ul className="skills__list">{suggestions.map(renderSkill)}</ul>
          </section>
        ) : null}
        <section>
          <h3>Your skills</h3>
          {skills.length === 0 ? (
            <p className="skills__empty">No skills yet. Create one below or import a SKILL.md.</p>
          ) : (
            <ul className="skills__list">{skills.map(renderSkill)}</ul>
          )}
          {builtIn.length > 0 ? (
            <p className="skills__meta">
              Built in: {builtIn.map((skill) => skill.name).join(', ')}
            </p>
          ) : null}
        </section>
        <section>
          <h3>Add from GitHub</h3>
          <div className="skills__inline">
            <input
              aria-label="GitHub SKILL.md URL"
              placeholder="https://github.com/owner/repo/blob/main/SKILL.md"
              value={githubUrl}
              onChange={(event) => setGithubUrl(event.target.value)}
            />
            <Button disabled={busy || !githubUrl.trim()} onClick={() => void importUrl()}>
              Import
            </Button>
          </div>
        </section>
        <section>
          <h3>Create with AI</h3>
          <textarea
            aria-label="Describe the skill"
            placeholder="Describe what the assistant should always do…"
            rows={2}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
          <textarea
            aria-label="Skill instructions"
            placeholder="Instructions, e.g. answer in bullet points and cite the policy name."
            rows={3}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
          />
          <Button
            disabled={busy || description.trim().length < 10 || !instructions.trim()}
            onClick={() => void create()}
          >
            Create skill
          </Button>
        </section>
      </div>
    </div>
  );
}
