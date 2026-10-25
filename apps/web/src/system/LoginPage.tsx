import { useState } from 'react';
import type { FormEvent } from 'react';

import { apiFetch, setSession, type StoredSession } from '../host/api';

/** First-run / session-expiry gate. Bootstrap registration creates the first admin. */
export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const path = mode === 'login' ? '/api/v1/auth/login' : '/api/v1/auth/register';
      const body = mode === 'login' ? { email, password } : { email, password, name };
      const res = await apiFetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { detail?: string };
        throw new Error(payload.detail ?? `sign-in failed (${res.status})`);
      }
      setSession((await res.json()) as StoredSession);
      window.location.reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main style={{ maxWidth: 360, margin: '4rem auto' }}>
      <h1>TriageAI</h1>
      <p>{mode === 'login' ? 'Sign in to continue.' : 'Create the first admin account.'}</p>
      <form onSubmit={submit}>
        {mode === 'register' && (
          <label style={{ display: 'block' }}>
            Name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              style={{ display: 'block', width: '100%' }}
            />
          </label>
        )}
        <label style={{ display: 'block' }}>
          Email
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            style={{ display: 'block', width: '100%' }}
          />
        </label>
        <label style={{ display: 'block' }}>
          Password
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            minLength={10}
            style={{ display: 'block', width: '100%' }}
          />
        </label>
        <button type="submit" disabled={busy} style={{ marginTop: 12 }}>
          {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create admin'}
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      <button
        type="button"
        onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
        style={{ marginTop: 12 }}
      >
        {mode === 'login' ? 'First run? Create the admin account' : 'Back to sign in'}
      </button>
    </main>
  );
}
