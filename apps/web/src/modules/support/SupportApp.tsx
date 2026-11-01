import { useCallback, useEffect, useState } from 'react';
import { apiFetch, getSession, type ApiFailure } from '../../host/api';
import {
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Field,
  Input,
  Page,
  StatusText,
  Table,
} from '../../ui';

interface Ticket {
  id: string;
  subject: string;
  body: string;
  requester: string;
  status: string;
  category: string | null;
  confidence: number | null;
  margin: number | null;
  priority: string | null;
  team: string | null;
  priorityCode: string | null;
  teamId: string | null;
  classification: { reasonCodes?: string[]; modelVersion?: string } | null;
  routing: { ruleIds?: string[]; rulesVersion?: number; reasons?: string[] } | null;
  triage: { ambiguous?: boolean; reasons?: string[] } | null;
  slaDueAt?: string | null;
  slaBreachedAt?: string | null;
  assigneeId?: string | null;
  csatScore?: number | null;
  createdAt: string;
}

interface TriagePolicy {
  priorities: string[];
  teamIds: string[];
  ambiguous: string;
}

interface TicketDetail {
  ticket: Ticket;
  messages: Array<{
    id: string;
    authorType: string;
    author: string | null;
    body: string;
    createdAt: string;
  }>;
  events: Array<{
    id: string;
    type: string;
    payload: unknown;
    actor: string | null;
    createdAt: string;
  }>;
}

const STATUS_COLORS: Record<string, string> = {
  NEW: '#57606a',
  ROUTED: '#0969da',
  HUMAN_REVIEW: '#8250df',
  RESOLVED: '#1a7f37',
  CANCELLED: '#9a6700',
};

export default function SupportApp() {
  const customer = getSession()?.user.role === 'customer';
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [selected, setSelected] = useState<TicketDetail | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<ApiFailure | null>(null);
  const [policy, setPolicy] = useState<TriagePolicy>({
    priorities: [],
    teamIds: [],
    ambiguous: '',
  });
  const [priorityCode, setPriorityCode] = useState('');
  const [teamId, setTeamId] = useState('');
  const [assignee, setAssignee] = useState('');

  const load = useCallback(async () => {
    const res = await apiFetch<Ticket[]>(
      customer ? '/api/v1/support/my-tickets' : '/api/v1/support/tickets?limit=50',
    );
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError(null);
    setTickets(res.data);
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (customer) return;
    void (async () => {
      const res = await apiFetch<Partial<TriagePolicy>>('/api/v1/support/triage-policy');
      if (!res.ok) return;
      const body = res.data;
      if (Array.isArray(body.priorities) && Array.isArray(body.teamIds)) {
        setPolicy({
          priorities: body.priorities,
          teamIds: body.teamIds,
          ambiguous: body.ambiguous ?? '',
        });
      }
    })();
  }, []);

  const openTicket = async (id: string) => {
    const res = await apiFetch<TicketDetail>(`/api/v1/support/tickets/${id}`);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    const detail = res.data;
    setSelected(detail);
    setPriorityCode(detail.ticket.priorityCode ?? policy.priorities[0] ?? '');
    setTeamId(detail.ticket.teamId ?? policy.teamIds[0] ?? '');
    setAssignee(detail.ticket.assigneeId ?? '');
  };

  useEffect(() => {
    if (!selected) return;
    setPriorityCode(selected.ticket.priorityCode ?? policy.priorities[0] ?? '');
    setTeamId(selected.ticket.teamId ?? policy.teamIds[0] ?? '');
    // Re-sync only when the open ticket or the policy changes.
  }, [selected?.ticket.id, selected?.ticket.priorityCode, selected?.ticket.teamId, policy]);

  const saveTriage = async () => {
    if (!selected || !priorityCode || !teamId) return;
    setError(null);
    const res = await apiFetch(`/api/v1/support/tickets/${selected.ticket.id}/triage`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        priorityCode,
        teamId,
        actor: 'ui-agent',
        method: 'mistake',
        note: 'Manual triage override from the agent queue',
      }),
    });
    if (!res.ok) {
      setError(res.error);
      return;
    }
    await openTicket(selected.ticket.id);
    await load();
  };

  const createTicket = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    const res = await apiFetch('/api/v1/support/tickets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subject, body, requester: 'ui-user' }),
    });
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setSubject('');
    setBody('');
    await load();
  };

  const assignTicket = async () => {
    if (!selected || !assignee.trim()) return;
    const res = await apiFetch(`/api/v1/support/tickets/${selected.ticket.id}/assignment`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assigneeId: assignee.trim() }),
    });
    if (!res.ok) setError(res.error);
    else await openTicket(selected.ticket.id);
  };

  const rate = async (score: number) => {
    if (!selected) return;
    const res = await apiFetch(`/api/v1/support/tickets/${selected.ticket.id}/csat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ score }),
    });
    if (!res.ok) setError(res.error);
    else await openTicket(selected.ticket.id);
  };

  const resolveTicket = async () => {
    if (!selected) return;
    const res = await apiFetch(`/api/v1/support/tickets/${selected.ticket.id}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'ui-agent', note: 'Resolved from the agent queue' }),
    });
    if (!res.ok) setError(res.error);
    else await openTicket(selected.ticket.id);
    await load();
  };

  return (
    <Page
      title="Support"
      subtitle="Tickets are classified, routed, and resolved with a full decision trail."
    >
      <ErrorNotice error={error} onRetry={() => void load()} />

      <Card title="New ticket">
        <form className="ui-form" onSubmit={createTicket}>
          <Field label="Subject">
            <Input
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              placeholder="Subject"
              aria-label="ticket subject"
              required
            />
          </Field>
          <Field label="Description">
            <Input
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="Describe the issue"
              aria-label="ticket body"
              size={40}
              required
            />
          </Field>
          <Button type="submit" variant="primary">
            Create ticket
          </Button>
        </form>
      </Card>

      <Card title="Queue">
        {tickets.length === 0 ? (
          <EmptyState>No tickets yet. Create one above.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Ticket</th>
                <th>Status</th>
                <th>Category</th>
                <th>Team</th>
                <th>Priority</th>
              </tr>
            </thead>
            <tbody>
              {tickets.map((ticket) => (
                <tr key={ticket.id}>
                  <td>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => void openTicket(ticket.id)}
                    >
                      {ticket.subject}
                    </Button>
                  </td>
                  <td>
                    <StatusText
                      status={ticket.status}
                      color={STATUS_COLORS[ticket.status] ?? 'inherit'}
                    />
                  </td>
                  <td>{ticket.category ?? '—'}</td>
                  <td>{ticket.teamId ?? ticket.team ?? '—'}</td>
                  <td>{ticket.priorityCode ?? ticket.priority ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {selected && (
        <Card title={selected.ticket.subject}>
          <div className="ui-row">
            <Button type="button" onClick={() => setSelected(null)}>
              Close
            </Button>
          </div>
          <p>{selected.ticket.body}</p>
          <p>
            <strong>Status:</strong> {selected.ticket.status} · <strong>Category:</strong>{' '}
            {selected.ticket.category ?? '—'}
            {selected.ticket.confidence != null &&
              ` (${(selected.ticket.confidence * 100).toFixed(0)}% / margin ${selected.ticket.margin?.toFixed(2)})`}
          </p>
          <p>
            <strong>SLA:</strong>{' '}
            {selected.ticket.slaDueAt
              ? `${new Date(selected.ticket.slaDueAt).toLocaleString()}${selected.ticket.slaBreachedAt ? ' (breached)' : ''}`
              : '—'}{' '}
            · <strong>Assignee:</strong> {selected.ticket.assigneeId ?? '—'}
          </p>
          <p>
            <strong>Routing:</strong> {selected.ticket.teamId ?? selected.ticket.team ?? '—'} ·{' '}
            {selected.ticket.priorityCode ?? selected.ticket.priority ?? '—'}
            {selected.ticket.routing?.ruleIds?.length
              ? ` · rules ${selected.ticket.routing.ruleIds.join(', ')} (v${selected.ticket.routing.rulesVersion})`
              : ''}
          </p>
          {selected.ticket.triage?.ambiguous && (
            <p role="status">
              <strong>Manual triage:</strong>{' '}
              {(selected.ticket.triage.reasons ?? []).join(', ') || 'ambiguous signals'}
            </p>
          )}
          {!customer && (
            <form
              className="ui-form"
              onSubmit={(event) => {
                event.preventDefault();
                void assignTicket();
              }}
            >
              <Field label="Assignee">
                <Input
                  value={assignee}
                  onChange={(event) => setAssignee(event.target.value)}
                  aria-label="assignee"
                  placeholder="agent id"
                />
              </Field>
              <Button type="submit">Assign</Button>
            </form>
          )}
          {!customer && policy.priorities.length > 0 && (
            <form
              className="ui-form"
              onSubmit={(event) => {
                event.preventDefault();
                void saveTriage();
              }}
            >
              <Field label="Priority">
                <select
                  className="ui-input"
                  aria-label="triage priority"
                  value={priorityCode}
                  onChange={(event) => setPriorityCode(event.target.value)}
                >
                  {policy.priorities.map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Team">
                <select
                  className="ui-input"
                  aria-label="triage team"
                  value={teamId}
                  onChange={(event) => setTeamId(event.target.value)}
                >
                  {policy.teamIds.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              </Field>
              <Button type="submit">Save triage override</Button>
            </form>
          )}
          {selected.ticket.classification?.reasonCodes?.length ? (
            <p>
              <strong>Reasons:</strong>{' '}
              {selected.ticket.classification.reasonCodes.map((code) => (
                <code key={code} className="ui-code">
                  {code}{' '}
                </code>
              ))}
            </p>
          ) : null}
          {!customer &&
            selected.ticket.status !== 'RESOLVED' &&
            selected.ticket.status !== 'CANCELLED' && (
              <Button type="button" variant="primary" onClick={() => void resolveTicket()}>
                Mark resolved
              </Button>
            )}
          {customer && selected.ticket.status === 'RESOLVED' && (
            <div className="ui-row">
              <span>How did we do?</span>
              {[1, 2, 3, 4, 5].map((score) => (
                <Button
                  key={score}
                  type="button"
                  variant={selected.ticket.csatScore === score ? 'primary' : 'default'}
                  aria-label={`rate ${score}`}
                  onClick={() => void rate(score)}
                  disabled={selected.ticket.csatScore != null}
                >
                  {score}
                </Button>
              ))}
            </div>
          )}

          <h4>Messages</h4>
          {selected.messages.length === 0 ? (
            <EmptyState>No messages.</EmptyState>
          ) : (
            <ul>
              {selected.messages.map((message) => (
                <li key={message.id}>
                  <strong>{message.authorType}</strong> {message.author ?? ''}: {message.body}
                </li>
              ))}
            </ul>
          )}
          <h4>Events</h4>
          {selected.events.length === 0 ? (
            <EmptyState>No events.</EmptyState>
          ) : (
            <ul>
              {selected.events.map((event) => (
                <li key={event.id}>
                  {event.type} · {event.actor ?? 'system'} ·{' '}
                  {new Date(event.createdAt).toLocaleString()}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </Page>
  );
}
