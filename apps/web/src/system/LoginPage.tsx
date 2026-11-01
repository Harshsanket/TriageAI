import { useState } from 'react';
import type { FormEvent } from 'react';

import { apiFetch, setSession, type StoredSession } from '../host/api';
import { Button, Card, ErrorNotice, Field, Input } from '../ui';

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
      const res = await apiFetch<StoredSession>(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError(res.error.envelope.userMessage);
        return;
      }
      setSession(res.data);
      window.location.reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="ui-page" style={{ maxWidth: 380, marginTop: '4rem' }}>
      <h1>TriageAI</h1>
      <Card title={mode === 'login' ? 'Sign in' : 'Create the first admin account'}>
        <form className="ui-stack" onSubmit={submit}>
          {mode === 'register' && (
            <Field label="Name">
              <Input value={name} onChange={(event) => setName(event.target.value)} required />
            </Field>
          )}
          <Field label="Email">
            <Input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </Field>
          <Field label="Password">
            <Input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              minLength={10}
            />
          </Field>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create admin'}
          </Button>
        </form>
        <ErrorNotice error={error} />
        <Button
          type="button"
          variant="ghost"
          onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
        >
          {mode === 'login' ? 'First run? Create the admin account' : 'Back to sign in'}
        </Button>
      </Card>
    </main>
  );
}
