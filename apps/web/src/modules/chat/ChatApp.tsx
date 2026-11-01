import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';

import { PreferencesResponseSchema } from '@triageai/contracts';

import { apiFetch, type ApiFailure } from '../../host/api';
import { readChatFiles, saveAttachmentsToKb, type ChatAttachment } from '../../host/attachments';
import { ProgressStatus } from '../../ui/ProgressStatus';
import { Button, Card, EmptyState, ErrorNotice, Field, Input, Page } from '../../ui';

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  citations: string[];
  createdAt: string;
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <path
        d="M10 15V5M5.5 9.5 10 5l4.5 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface ChatContext {
  usedTokens: number;
  totalTokens: number;
  availableTokens?: number;
  percent: number;
  highWaterPercent?: number;
  compacted: boolean;
  degraded?: boolean;
  summaryVersion: number;
  droppedTurns?: number;
  measuredAt: string;
}

interface ConversationSummary {
  id: string;
  title: string;
  pinned: boolean;
  summary?: string | null;
  lastMessage?: string | null;
  createdAt: string;
  updatedAt: string;
}

export default function ChatApp({
  initialConversationId,
  showSidebar = true,
  sidebarOnly = false,
  kbEnabled = false,
  onNewChat,
  onConversationChange,
}: {
  initialConversationId?: string;
  showSidebar?: boolean;
  sidebarOnly?: boolean;
  kbEnabled?: boolean;
  onNewChat?: () => void;
  onConversationChange?: (id: string | null) => void;
} = {}) {
  const [conversationId, setConversationId] = useState<string | null>(
    initialConversationId ?? null,
  );
  const [messages, setMessages] = useState<Message[]>([]);
  const [context, setContext] = useState<ChatContext | null>(null);
  const [showContext, setShowContext] = useState(false);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [query, setQuery] = useState('');
  const [text, setText] = useState(() => {
    try {
      return sessionStorage.getItem('triageai.homeDraft') ?? '';
    } catch {
      return '';
    }
  });
  const [error, setError] = useState<ApiFailure | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [agent, setAgent] = useState({ displayName: 'TriageAI', color: '#3b6fd4' });
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [fileNote, setFileNote] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const busy = useRef(false);

  useEffect(() => {
    let disposed = false;
    void apiFetch<unknown>('/api/v1/me/preferences').then((result) => {
      if (disposed || !result.ok) return;
      const parsed = PreferencesResponseSchema.safeParse(result.data);
      const chatAgent = parsed.success
        ? parsed.data.agents.find((entry) => entry.id === 'chat')
        : undefined;
      if (chatAgent) {
        setAgent({ displayName: chatAgent.displayName, color: chatAgent.color });
      }
    });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    try {
      sessionStorage.removeItem('triageai.homeDraft');
    } catch {
      // Storage can be unavailable in private mode.
    }
  }, []);

  const loadList = useCallback(
    async (search = query) => {
      const res = await apiFetch<{ conversations: ConversationSummary[] }>(
        `/api/v1/chat/conversations${search ? `?q=${encodeURIComponent(search)}` : ''}`,
      );
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setError(null);
      setConversations(res.data.conversations);
    },
    [query],
  );

  const load = useCallback(async (id: string) => {
    const res = await apiFetch<{ messages: Message[]; context?: ChatContext | null }>(
      `/api/v1/chat/conversations/${id}`,
    );
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError(null);
    setMessages(res.data.messages);
    setContext(res.data.context ?? null);
  }, []);

  useEffect(() => {
    void loadList('');
  }, [loadList]);

  useEffect(() => {
    setConversationId(initialConversationId ?? null);
    if (initialConversationId) void load(initialConversationId);
    else {
      setMessages([]);
      setContext(null);
    }
  }, [initialConversationId, load]);

  useEffect(() => {
    if (!conversationId) return;
    const timer = setInterval(() => {
      if (!busy.current) void load(conversationId);
    }, 1000);
    return () => clearInterval(timer);
  }, [conversationId, load]);

  useEffect(() => {
    const input = composerInput.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = text ? `${Math.min(input.scrollHeight, 128)}px` : '';
  }, [text]);

  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    const message = [
      text.trim(),
      ...attachments.map((file) => `[Attached: ${file.name}]\n${file.text}`),
    ]
      .filter(Boolean)
      .join('\n\n');
    if (!message) return;
    setError(null);
    busy.current = true;
    setWaiting(true);
    try {
      if (kbEnabled) await saveAttachmentsToKb(attachments);
      const res = await apiFetch<{ conversationId: string }>('/api/v1/chat/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId: conversationId ?? undefined, text: message }),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setConversationId(res.data.conversationId);
      onConversationChange?.(res.data.conversationId);
      setText('');
      setAttachments([]);
      await load(res.data.conversationId);
      await loadList();
      setWaiting(false);
    } finally {
      busy.current = false;
    }
  };

  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    const { accepted, rejected } = await readChatFiles(files);
    if (accepted.length > 0) setAttachments((current) => [...current, ...accepted]);
    setFileNote(
      rejected.length > 0
        ? rejected.join('; ')
        : accepted.length > 0
          ? `Attached: ${accepted.map((file) => file.name).join(', ')}`
          : null,
    );
  };

  const onComposerKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  const rename = async (conversation: ConversationSummary) => {
    const title = globalThis.prompt?.('Rename conversation', conversation.title);
    if (!title) return;
    const res = await apiFetch(`/api/v1/chat/conversations/${conversation.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    if (!res.ok) setError(res.error);
    else await loadList();
  };

  const togglePin = async (conversation: ConversationSummary) => {
    const res = await apiFetch(`/api/v1/chat/conversations/${conversation.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pinned: !conversation.pinned }),
    });
    if (!res.ok) setError(res.error);
    else await loadList();
  };

  const remove = async (conversation: ConversationSummary) => {
    const res = await apiFetch(`/api/v1/chat/conversations/${conversation.id}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      setError(res.error);
      return;
    }
    if (conversation.id === conversationId) {
      setConversationId(null);
      setMessages([]);
      onConversationChange?.(null);
    }
    await loadList();
  };

  const sidebarPanel = (
    <aside className="ui-chat-sidebar" aria-label="Conversation history">
      <div className="ui-stack">
        <Button
          type="button"
          variant="primary"
          onClick={() => {
            setConversationId(null);
            setMessages([]);
            setText('');
            setAttachments([]);
            onConversationChange?.(null);
            onNewChat?.();
          }}
        >
          New chat
        </Button>
        <form
          className="ui-form"
          onSubmit={(event) => {
            event.preventDefault();
            void loadList(query);
          }}
        >
          <Field label="Search">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="search conversations"
              placeholder="Search conversations"
            />
          </Field>
        </form>
      </div>
      {conversations.length === 0 ? (
        <EmptyState>No conversations yet.</EmptyState>
      ) : (
        <ul className="ui-chat-list">
          {conversations.map((conversation) => (
            <li
              key={conversation.id}
              className={
                conversation.id === conversationId
                  ? 'ui-chat-list__item ui-chat-list__item--active'
                  : 'ui-chat-list__item'
              }
            >
              <button
                type="button"
                className="ui-chat-list__open"
                onClick={() => {
                  setConversationId(conversation.id);
                  onConversationChange?.(conversation.id);
                  void load(conversation.id);
                }}
              >
                <span className="ui-chat-list__title">
                  {conversation.pinned ? '📌 ' : ''}
                  {conversation.title}
                </span>
                <span className="ui-chat-list__meta">
                  {new Date(conversation.updatedAt).toLocaleString()}
                </span>
                {conversation.lastMessage ? (
                  <span className="ui-chat-list__last">
                    {conversation.lastMessage.slice(0, 80)}
                  </span>
                ) : null}
              </button>
              <div className="ui-chat-list__actions">
                <Button
                  type="button"
                  variant="ghost"
                  aria-label={`pin ${conversation.title}`}
                  onClick={() => void togglePin(conversation)}
                >
                  {conversation.pinned ? 'Unpin' : 'Pin'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  aria-label={`rename ${conversation.title}`}
                  onClick={() => void rename(conversation)}
                >
                  Rename
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  aria-label={`delete ${conversation.title}`}
                  onClick={() => void remove(conversation)}
                >
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );

  if (sidebarOnly) return sidebarPanel;

  return (
    <Page title="Chat" subtitle="Answers are grounded in approved knowledge or refused explicitly.">
      <ErrorNotice
        error={error}
        onRetry={conversationId ? () => void load(conversationId) : () => void loadList()}
      />
      {waiting && <ProgressStatus state="searching" />}
      <div className={`ui-chat-layout${showSidebar ? '' : ' ui-chat-layout--full'}`}>
        {showSidebar && sidebarPanel}

        <Card
          title={conversationId ? 'Conversation' : 'New conversation'}
          actions={
            showSidebar ? undefined : (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setConversationId(null);
                  setMessages([]);
                  setText('');
                  setAttachments([]);
                  onConversationChange?.(null);
                  onNewChat?.();
                }}
              >
                New chat
              </Button>
            )
          }
        >
          <div className="ui-chat">
            {messages.length === 0 ? (
              <EmptyState>No messages yet. Ask a question below.</EmptyState>
            ) : (
              messages.map((message) => (
                <article
                  key={message.id}
                  className={`ui-chat__message ui-chat__message--${message.role === 'assistant' ? 'assistant' : 'user'}`}
                >
                  <div
                    className="ui-chat__bubble"
                    style={
                      message.role === 'assistant'
                        ? ({ backgroundColor: agent.color, color: '#ffffff' } as CSSProperties)
                        : undefined
                    }
                  >
                    <p className="ui-chat__body">{message.content}</p>
                    {message.citations.length > 0 && (
                      <p className="ui-citations">
                        sources: {message.citations.map((citation) => `[${citation}]`).join(' ')}
                      </p>
                    )}
                  </div>
                  {message.role === 'assistant' ? (
                    <span className="ui-chat__name" style={{ color: agent.color }}>
                      {agent.displayName}
                    </span>
                  ) : null}
                </article>
              ))
            )}
          </div>
          <form className="ui-composer" onSubmit={send}>
            {attachments.length > 0 ? (
              <ul className="ui-composer__attachments" aria-label="Attached files">
                {attachments.map((file, index) => {
                  const key = `${file.name}-${index}`;
                  const expanded = expandedFiles.has(key);
                  return (
                    <li key={key} className={expanded ? 'is-expanded' : undefined}>
                      <button
                        type="button"
                        className="ui-composer__attachment-name"
                        title={file.name}
                        aria-expanded={expanded}
                        onClick={() =>
                          setExpandedFiles((current) => {
                            const next = new Set(current);
                            if (next.has(key)) next.delete(key);
                            else next.add(key);
                            return next;
                          })
                        }
                      >
                        {file.name}
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove ${file.name}`}
                        onClick={() => {
                          setAttachments((current) => current.filter((_, item) => item !== index));
                          setExpandedFiles((current) => {
                            const next = new Set(current);
                            next.delete(key);
                            return next;
                          });
                        }}
                      >
                        ×
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
            <div className="ui-composer__row">
              <input
                ref={fileInput}
                type="file"
                multiple
                accept=".txt,.md,.markdown,.csv,.json,.html,.htm,.pdf,image/png,image/jpeg,image/webp,image/gif"
                aria-label="Choose files"
                className="visually-hidden"
                onChange={(event) => {
                  void addFiles(event.target.files);
                  event.target.value = '';
                }}
              />
              <button
                type="button"
                className="ui-composer__tool"
                aria-label="Add files"
                title="Add files"
                onClick={() => fileInput.current?.click()}
              >
                <PlusIcon />
              </button>
              {context ? (
                <button
                  type="button"
                  className={`ui-context-ring${context.percent >= (context.highWaterPercent ?? 83) ? ' ui-context-ring--warning' : ''}`}
                  style={{ '--context-percent': `${context.percent}%` } as CSSProperties}
                  aria-label={`Context used ${context.usedTokens} of ${context.totalTokens} tokens (${context.percent}%). ${context.compacted ? 'Compaction has run.' : 'No compaction yet.'}`}
                  title={`${context.usedTokens} / ${context.totalTokens} tokens · ${context.percent}%${context.compacted ? ' · compacted' : ''}`}
                  onClick={() => setShowContext((value) => !value)}
                  onBlur={() => setShowContext(false)}
                >
                  <span aria-hidden="true">{context.percent}%</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="ui-context-ring ui-context-ring--empty"
                  aria-label="Context usage not measured yet"
                  title="Context usage not measured yet"
                >
                  <span aria-hidden="true">–</span>
                </button>
              )}
              {showContext && context ? (
                <span className="ui-context-tip" role="status">
                  {context.usedTokens} / {context.totalTokens} tokens ({context.percent}%)
                  {context.compacted ? ` · compacted to v${context.summaryVersion}` : ''}
                </span>
              ) : null}
              <label className="visually-hidden" htmlFor="chat-message">
                Chat message
              </label>
              <textarea
                id="chat-message"
                ref={composerInput}
                className="ui-composer__input"
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={onComposerKey}
                aria-label="chat message"
                placeholder="Ask TriageAI anything…"
                rows={1}
              />
              <button
                type="submit"
                className="ui-composer__send"
                aria-label="Send message"
                disabled={waiting}
              >
                <SendIcon />
              </button>
            </div>
            {fileNote ? (
              <p className="ui-composer__note" role="status">
                {fileNote}
              </p>
            ) : null}
          </form>
        </Card>
      </div>
    </Page>
  );
}
