import { useState } from 'react';

export default function ChatApp() {
  const [reply, setReply] = useState<string | null>(null);
  const [text, setText] = useState('ping');

  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    const res = await fetch('/api/v1/chat/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (res.ok) {
      const data = (await res.json()) as { greeting?: string };
      setReply(data.greeting ?? null);
    } else {
      setReply('chat failed');
    }
  };

  return (
    <main>
      <h2>Chat</h2>
      <form onSubmit={send}>
        <input value={text} onChange={(e) => setText(e.target.value)} aria-label="chat text" />
        <button type="submit">Send</button>
      </form>
      {reply && <p>{reply}</p>}
    </main>
  );
}
