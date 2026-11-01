import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';

import type { SystemManifest } from '@triageai/contracts';

import { apiFetch, getSession, type ApiFailure } from '../host/api';
import { readChatFiles, saveAttachmentsToKb, type ChatAttachment } from '../host/attachments';
import { navigate, useSearchParam } from '../host/router';
import ChatApp from '../modules/chat/ChatApp';
import { SkillsDrawer } from '../modules/skills/SkillsDrawer';
import { ErrorNotice } from '../ui';
import { greeting } from './greeting';
import { AsciiOcean } from './ocean';
import type { SharkSpec } from './ocean';

/** A slow, varied roster: the big hammerhead sets the scale, the rest trail it. */
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

const SHARKS: SharkSpec[] = [
  { kind: 'hammerhead', size: 1 },
  { kind: 'classic', size: 0.84 },
  { kind: 'mako', size: 0.74 },
  { kind: 'classic', size: 0.66 },
];

function PlusIcon() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <rect
        x="7"
        y="2.5"
        width="6"
        height="9"
        rx="3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
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
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PanelLeftIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <rect
        x="3"
        y="4"
        width="18"
        height="16"
        rx="2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path d="M9 4v16" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export default function HomePage({
  manifest,
  sidebarOpen,
  onToggleSidebar,
}: {
  manifest: SystemManifest;
  sidebarOpen: boolean;
  onToggleSidebar?: () => void;
}) {
  const paramConversationId = useSearchParam('c');
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(paramConversationId);
  const [starting, setStarting] = useState(false);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [expandedAttachment, setExpandedAttachment] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const chatEnabled = manifest.modules.some((module) => module.id === 'chat');
  const kbEnabled = manifest.modules.some((module) => module.id === 'kb');
  const userName = getSession()?.user.name ?? null;
  const firstVisit = globalThis.localStorage?.getItem('triageai.seen') !== '1';
  if (globalThis.localStorage && firstVisit) globalThis.localStorage.setItem('triageai.seen', '1');
  const hello = greeting(userName, new Date(), undefined, firstVisit);

  // `/?c=<id>` is the durable home-conversation location: a reload, a
  // back/forward move or a shared link reopens the same conversation.
  useEffect(() => {
    setConversationId(paramConversationId);
  }, [paramConversationId]);

  const openConversation = (id: string | null) => {
    setConversationId(id);
    navigate(id ? `/?c=${encodeURIComponent(id)}` : '/', { replace: true });
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const prompt = draft.trim();
    const attachmentText = attachments
      .map((file) => `[Attached: ${file.name}]\n${file.text}`)
      .join('\n\n');
    const message = [prompt, attachmentText].filter(Boolean).join('\n\n');
    if (!message) return;
    if (!chatEnabled) {
      setNote('Chat is not enabled in this configuration.');
      return;
    }
    setStarting(true);
    setError(null);
    try {
      if (kbEnabled) await saveAttachmentsToKb(attachments);
      const res = await apiFetch<{ conversationId: string }>('/api/v1/chat/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: message }),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setDraft('');
      setAttachments([]);
      // Stay on `/`: the landing page becomes the conversation surface.
      openConversation(res.data.conversationId);
    } finally {
      setStarting(false);
    }
  };

  const newChat = () => {
    openConversation(null);
    setDraft('');
    setAttachments([]);
    setNote(null);
    setError(null);
  };

  const addFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const { accepted, rejected } = await readChatFiles(files);
    if (accepted.length > 0) setAttachments((current) => [...current, ...accepted]);
    setNote(
      rejected.length > 0
        ? rejected.join('; ')
        : accepted.length > 0
          ? `Attached: ${accepted.map((file) => file.name).join(', ')}`
          : null,
    );
  };

  const toggleMic = () => {
    if (listening) {
      recognition.current?.stop();
      setListening(false);
      return;
    }
    const ctor =
      (globalThis as unknown as { SpeechRecognition?: SpeechRecognitionCtor }).SpeechRecognition ??
      (globalThis as unknown as { webkitSpeechRecognition?: SpeechRecognitionCtor })
        .webkitSpeechRecognition;
    if (!ctor) {
      setNote('Speech input is not supported in this browser.');
      return;
    }
    const instance = new ctor();
    instance.continuous = false;
    instance.interimResults = false;
    instance.lang = globalThis.navigator?.language ?? 'en-US';
    instance.onresult = (event) => {
      const transcript = Array.from({ length: event.results.length }, (_, index) => {
        const alternatives = event.results[index];
        return alternatives?.[0]?.transcript ?? '';
      })
        .join(' ')
        .trim();
      if (transcript) setDraft((current) => (current ? `${current} ${transcript}` : transcript));
    };
    instance.onerror = () => {
      setListening(false);
      setNote('Microphone access failed.');
    };
    instance.onend = () => setListening(false);
    recognition.current = instance;
    try {
      instance.start();
      setListening(true);
      setNote(null);
    } catch {
      setNote('Microphone access failed.');
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  const sidebarToggle = chatEnabled ? (
    <>
      {onToggleSidebar ? (
        <button
          className="home__sidebar-toggle"
          type="button"
          aria-label={sidebarOpen ? 'Hide conversation history' : 'Show conversation history'}
          aria-pressed={sidebarOpen}
          title={sidebarOpen ? 'Hide chats' : 'Show chats'}
          onClick={onToggleSidebar}
        >
          <PanelLeftIcon />
        </button>
      ) : null}
      <button
        className="home__skills-toggle"
        type="button"
        aria-label="Open skills"
        title="Skills"
        aria-expanded={skillsOpen}
        onClick={() => setSkillsOpen(true)}
      >
        <span aria-hidden="true">✦</span>
      </button>
    </>
  ) : null;

  if (chatEnabled && conversationId) {
    return (
      <main className={`home home--conversation${sidebarOpen ? ' home--with-sidebar' : ''}`}>
        {sidebarToggle}
        {skillsOpen ? <SkillsDrawer onClose={() => setSkillsOpen(false)} /> : null}
        <section className="home__conversation" aria-label="Conversation">
          <ChatApp
            initialConversationId={conversationId ?? undefined}
            showSidebar={sidebarOpen}
            kbEnabled={kbEnabled}
            onConversationChange={openConversation}
            onNewChat={newChat}
          />
        </section>
      </main>
    );
  }

  return (
    <main className={`home${sidebarOpen ? ' home--drawer' : ''}`}>
      {sidebarToggle}
      {skillsOpen ? <SkillsDrawer onClose={() => setSkillsOpen(false)} /> : null}
      {chatEnabled && sidebarOpen ? (
        <div className="home__drawer" role="dialog" aria-label="Conversation history">
          <ChatApp sidebarOnly onConversationChange={openConversation} onNewChat={newChat} />
        </div>
      ) : null}
      <AsciiOcean className="home__ocean" sharks={SHARKS} />
      <div className="home__wash" aria-hidden="true" />
      <section className="home__panel" aria-labelledby="home-title">
        <h1 id="home-title" className="home__wordmark">
          TriageAI
        </h1>
        <p className="home__prompt" aria-label="greeting">
          {hello} — what&rsquo;s on your mind?
        </p>
        <ErrorNotice error={error} />
        <form className="home__composer" onSubmit={submit} aria-label="Ask TriageAI">
          {attachments.length > 0 && (
            <ul className="home__attachments" aria-label="Attached files">
              {attachments.map((file, index) => (
                <li
                  key={`${file.name}-${index}`}
                  className={`home__attachment${expandedAttachment === `${file.name}-${index}` ? ' home__attachment--expanded' : ''}`}
                >
                  <span className={`home__attachment-icon home__attachment-icon--${file.kind}`}>
                    {file.kind === 'pdf' ? 'PDF' : file.kind === 'image' ? 'IMG' : 'TXT'}
                  </span>
                  <button
                    type="button"
                    className="home__attachment-name"
                    title={file.name}
                    aria-expanded={expandedAttachment === `${file.name}-${index}`}
                    onClick={() =>
                      setExpandedAttachment((current) =>
                        current === `${file.name}-${index}` ? null : `${file.name}-${index}`,
                      )
                    }
                  >
                    {file.name}
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${file.name}`}
                    onClick={() =>
                      setAttachments((current) => current.filter((_, item) => item !== index))
                    }
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <label className="visually-hidden" htmlFor="home-ask">
            Ask TriageAI anything
          </label>
          <textarea
            id="home-ask"
            className="home__input"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              if (note) setNote(null);
            }}
            onKeyDown={onKeyDown}
            placeholder="Ask TriageAI anything…"
            rows={2}
          />
          <div className="home__toolbar">
            <div className="home__tools">
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
                className="home__tool"
                type="button"
                aria-label="Add files"
                title="Add files"
                onClick={() => fileInput.current?.click()}
              >
                <PlusIcon />
              </button>
              <button
                className={`home__tool${listening ? ' home__tool--active' : ''}`}
                type="button"
                aria-label={listening ? 'Stop microphone' : 'Use microphone'}
                aria-pressed={listening}
                title={listening ? 'Stop microphone' : 'Use microphone'}
                onClick={toggleMic}
              >
                <MicIcon />
              </button>
            </div>
            <span className="home__hint">↵ send · ⇧↵ newline</span>
            <button
              className="home__send"
              type="submit"
              aria-label="Send message"
              disabled={starting}
            >
              <SendIcon />
            </button>
          </div>
        </form>
        {note ? (
          <p className="home__note" role="status">
            {note}
          </p>
        ) : (
          <p className="home__note">
            {chatEnabled
              ? starting
                ? 'Starting the conversation…'
                : 'TriageAI answers here, grounded in your knowledge base.'
              : 'Enable the chat module to start a conversation.'}
          </p>
        )}
      </section>
    </main>
  );
}
