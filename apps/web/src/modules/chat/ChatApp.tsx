import { useCallback, useEffect, useRef, useState } from 'react';

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  citations: string[];
  createdAt: string;
}

export default function ChatApp() {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  const load = useCallback(async (id: string) => {
    const res = await fetch(`/api/v1/chat/conversations/${id}`);
    if (!res.ok) return;
    const body = (await res.json()) as { messages: Message[] };
    setMessages(body.messages);
  }, []);

  useEffect(() => {
    if (!conversationId) return;
    const timer = setInterval(() => {
      if (!busy.current) void load(conversationId);
    }, 1000);
    return () => clearInterval(timer);
  }, [conversationId, load]);

  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!text.trim()) return;
    setError(null);
    busy.current = true;
    try {
      const res = await fetch('/api/v1/chat/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId: conversationId ?? undefined, text }),
      });
      if (!res.ok) {
        setError(`send failed (${res.status})`);
        return;
      }
      const body = (await res.json()) as { conversationId: string };
      setConversationId(body.conversationId);
      setText('');
      await load(body.conversationId);
    } finally {
      busy.current = false;
    }
  };

  return (
    <section>
      <h2>Chat</h2>
      {error && <p role="alert">{error}</p>}
      <div style={{ maxWidth: 720 }}>
        {messages.map((message) => (
          <article
            key={message.id}
            style={{
              margin: '8px 0',
              padding: 8,
              borderLeft: `3px solid ${message.role === 'user' ? '#0969da' : '#1a7f37'}`,
            }}
          >
            <strong>{message.role}</strong>
            <p style={{ whiteSpace: 'pre-wrap', margin: '4px 0' }}>{message.content}</p>
            {message.citations.length > 0 && (
              <p style={{ fontSize: 12, color: '#57606a', margin: 0 }}>
                sources: {message.citations.map((citation) => `[${citation}]`).join(' ')}
              </p>
            )}
          </article>
        ))}
      </div>
      <form onSubmit={send} style={{ marginTop: 12 }}>
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          aria-label="chat message"
          placeholder="Ask about the knowledge base…"
          size={50}
        />{' '}
        <button type="submit">Send</button>
      </form>
    </section>
  );
}
