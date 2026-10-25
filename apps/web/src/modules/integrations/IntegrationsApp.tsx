import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../host/api';

interface Action {
  id: string;
  ticketId: string;
  kind: string;
  channel: string | null;
  status: string;
  reason: string | null;
  ref: string | null;
  url: string | null;
  createdAt: string;
}

const STATUS_COLORS: Record<string, string> = {
  pending_approval: '#8250df',
  approved: '#0969da',
  batched: '#9a6700',
  sent: '#1a7f37',
  suppressed: '#57606a',
  rejected: '#cf222e',
  failed: '#cf222e',
};

export function IntegrationsApp({
  provider,
  title,
}: {
  provider: 'github' | 'slack';
  title: string;
}) {
  const [actions, setActions] = useState<Action[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await apiFetch(`/api/v1/integrations/${provider}/actions`);
    if (!res.ok) return;
    setActions((await res.json()) as Action[]);
  }, [provider]);

  useEffect(() => {
    void load();
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, [load]);

  const mutate = async (id: string, operation: 'approve' | 'reject' | 'retry') => {
    setError(null);
    const res = await apiFetch(`/api/v1/integrations/${provider}/actions/${id}/${operation}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'ui-admin' }),
    });
    if (!res.ok) {
      setError(`${operation} failed (${res.status})`);
      return;
    }
    await load();
  };

  return (
    <section>
      <h2>{title}</h2>
      <p>
        Outward actions are audited. Approve or reject pending actions; failed deliveries can be
        retried without touching ticket state.
      </p>
      {error && <p role="alert">{error}</p>}
      <table cellPadding={6} style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th align="left">Ticket</th>
            <th align="left">Status</th>
            <th align="left">Channel</th>
            <th align="left">Ref</th>
            <th align="left">Reason</th>
            <th align="left">Actions</th>
          </tr>
        </thead>
        <tbody>
          {actions.map((action) => (
            <tr key={action.id} style={{ borderTop: '1px solid #ddd' }}>
              <td>{action.ticketId}</td>
              <td style={{ color: STATUS_COLORS[action.status] ?? '#24292f' }}>{action.status}</td>
              <td>{action.channel ?? '—'}</td>
              <td>
                {action.url ? (
                  <a href={action.url} target="_blank" rel="noreferrer">
                    {action.ref}
                  </a>
                ) : (
                  (action.ref ?? '—')
                )}
              </td>
              <td>{action.reason ?? '—'}</td>
              <td>
                {action.status === 'pending_approval' && (
                  <>
                    <button type="button" onClick={() => void mutate(action.id, 'approve')}>
                      Approve
                    </button>{' '}
                    <button type="button" onClick={() => void mutate(action.id, 'reject')}>
                      Reject
                    </button>
                  </>
                )}
                {action.status === 'failed' && (
                  <button type="button" onClick={() => void mutate(action.id, 'retry')}>
                    Retry
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {actions.length === 0 && <p>No integration actions yet.</p>}
    </section>
  );
}
