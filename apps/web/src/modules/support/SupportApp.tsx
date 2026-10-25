import { useCallback, useEffect, useState } from 'react';

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
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [selected, setSelected] = useState<TicketDetail | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [policy, setPolicy] = useState<TriagePolicy>({
    priorities: [],
    teamIds: [],
    ambiguous: '',
  });
  const [priorityCode, setPriorityCode] = useState('');
  const [teamId, setTeamId] = useState('');

  const load = useCallback(async () => {
    const res = await fetch('/api/v1/support/tickets?limit=50');
    if (!res.ok) return;
    setTickets((await res.json()) as Ticket[]);
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    void (async () => {
      const res = await fetch('/api/v1/support/triage-policy');
      if (!res.ok) return;
      const body = (await res.json()) as Partial<TriagePolicy>;
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
    const res = await fetch(`/api/v1/support/tickets/${id}`);
    if (!res.ok) return;
    const detail = (await res.json()) as TicketDetail;
    setSelected(detail);
    setPriorityCode(detail.ticket.priorityCode ?? policy.priorities[0] ?? '');
    setTeamId(detail.ticket.teamId ?? policy.teamIds[0] ?? '');
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
    const res = await fetch(`/api/v1/support/tickets/${selected.ticket.id}/triage`, {
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
      setError(`triage override failed (${res.status})`);
      return;
    }
    await openTicket(selected.ticket.id);
    await load();
  };

  const createTicket = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    const res = await fetch('/api/v1/support/tickets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subject, body, requester: 'ui-user' }),
    });
    if (!res.ok) {
      setError(`create failed (${res.status})`);
      return;
    }
    setSubject('');
    setBody('');
    await load();
  };

  const resolveTicket = async () => {
    if (!selected) return;
    const res = await fetch(`/api/v1/support/tickets/${selected.ticket.id}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'ui-agent', note: 'Resolved from the agent queue' }),
    });
    if (!res.ok) setError(`resolve failed (${res.status})`);
    else await openTicket(selected.ticket.id);
    await load();
  };

  return (
    <section>
      <h2>Support</h2>
      {error && <p role="alert">{error}</p>}

      <form onSubmit={createTicket} style={{ marginBottom: 16 }}>
        <input
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          placeholder="Subject"
          aria-label="ticket subject"
          required
        />{' '}
        <input
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Describe the issue"
          aria-label="ticket body"
          size={40}
          required
        />{' '}
        <button type="submit">Create ticket</button>
      </form>

      <table cellPadding={6} style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th align="left">Ticket</th>
            <th align="left">Status</th>
            <th align="left">Category</th>
            <th align="left">Team</th>
            <th align="left">Priority</th>
          </tr>
        </thead>
        <tbody>
          {tickets.map((ticket) => (
            <tr key={ticket.id} style={{ borderTop: '1px solid #ddd' }}>
              <td>
                <button type="button" onClick={() => void openTicket(ticket.id)}>
                  {ticket.subject}
                </button>
              </td>
              <td>
                <strong style={{ color: STATUS_COLORS[ticket.status] ?? 'inherit' }}>
                  {ticket.status}
                </strong>
              </td>
              <td>{ticket.category ?? '—'}</td>
              <td>{ticket.teamId ?? ticket.team ?? '—'}</td>
              <td>{ticket.priorityCode ?? ticket.priority ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {selected && (
        <article style={{ marginTop: 24, borderTop: '2px solid #ddd', paddingTop: 12 }}>
          <button type="button" onClick={() => setSelected(null)}>
            Close
          </button>
          <h3>{selected.ticket.subject}</h3>
          <p>{selected.ticket.body}</p>
          <p>
            <strong>Status:</strong> {selected.ticket.status} · <strong>Category:</strong>{' '}
            {selected.ticket.category ?? '—'}
            {selected.ticket.confidence != null &&
              ` (${(selected.ticket.confidence * 100).toFixed(0)}% / margin ${selected.ticket.margin?.toFixed(2)})`}
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
          {policy.priorities.length > 0 && (
            <p>
              <label>
                Priority{' '}
                <select
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
              </label>{' '}
              <label>
                Team{' '}
                <select
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
              </label>{' '}
              <button type="button" onClick={() => void saveTriage()}>
                Save triage override
              </button>
            </p>
          )}
          {selected.ticket.classification?.reasonCodes?.length ? (
            <p>
              <strong>Reasons:</strong>{' '}
              {selected.ticket.classification.reasonCodes.map((code) => (
                <code key={code} style={{ marginRight: 6 }}>
                  {code}
                </code>
              ))}
            </p>
          ) : null}
          {selected.ticket.status !== 'RESOLVED' && selected.ticket.status !== 'CANCELLED' && (
            <button type="button" onClick={() => void resolveTicket()}>
              Mark resolved
            </button>
          )}

          <h4>Messages</h4>
          <ul>
            {selected.messages.map((message) => (
              <li key={message.id}>
                <strong>{message.authorType}</strong> {message.author ?? ''}: {message.body}
              </li>
            ))}
          </ul>
          <h4>Events</h4>
          <ul>
            {selected.events.map((event) => (
              <li key={event.id}>
                {event.type} · {event.actor ?? 'system'} ·{' '}
                {new Date(event.createdAt).toLocaleString()}
              </li>
            ))}
          </ul>
        </article>
      )}
    </section>
  );
}
