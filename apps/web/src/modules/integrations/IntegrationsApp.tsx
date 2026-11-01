import { useCallback, useEffect, useState } from 'react';
import { apiFetch, type ApiFailure } from '../../host/api';
import {
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Page,
  StatusText,
  Table,
  safeExternalUrl,
} from '../../ui';

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
  const [error, setError] = useState<ApiFailure | null>(null);

  const load = useCallback(async () => {
    const res = await apiFetch<Action[]>(`/api/v1/integrations/${provider}/actions`);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError(null);
    setActions(res.data);
  }, [provider]);

  useEffect(() => {
    void load();
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, [load]);

  const mutate = async (id: string, operation: 'approve' | 'reject' | 'retry') => {
    const res = await apiFetch(`/api/v1/integrations/${provider}/actions/${id}/${operation}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'ui-admin' }),
    });
    if (!res.ok) {
      setError(res.error);
      return;
    }
    await load();
  };

  return (
    <Page
      title={title}
      subtitle="Outward actions are audited. Approve or reject pending actions; failed deliveries can be retried without touching ticket state."
    >
      <ErrorNotice error={error} onRetry={() => void load()} />
      <Card title="Actions">
        {actions.length === 0 ? (
          <EmptyState>No integration actions yet.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Ticket</th>
                <th>Status</th>
                <th>Channel</th>
                <th>Ref</th>
                <th>Reason</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {actions.map((action) => (
                <tr key={action.id}>
                  <td>{action.ticketId}</td>
                  <td>
                    <StatusText
                      status={action.status}
                      color={STATUS_COLORS[action.status] ?? '#24292f'}
                    />
                  </td>
                  <td>{action.channel ?? '—'}</td>
                  <td>
                    {safeExternalUrl(action.url) ? (
                      <a
                        href={safeExternalUrl(action.url) as string}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {action.ref}
                      </a>
                    ) : (
                      (action.ref ?? '—')
                    )}
                  </td>
                  <td>{action.reason ?? '—'}</td>
                  <td>
                    {action.status === 'pending_approval' && (
                      <div className="ui-row">
                        <Button type="button" onClick={() => void mutate(action.id, 'approve')}>
                          Approve
                        </Button>
                        <Button type="button" onClick={() => void mutate(action.id, 'reject')}>
                          Reject
                        </Button>
                      </div>
                    )}
                    {action.status === 'failed' && (
                      <Button type="button" onClick={() => void mutate(action.id, 'retry')}>
                        Retry
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </Page>
  );
}
