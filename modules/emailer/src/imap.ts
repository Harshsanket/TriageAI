/** IMAP polling (Phase 13.T2): a testable poller + ImapFlow source. */
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

export interface ImapInbound {
  messageId: string;
  from: string;
  subject: string;
  text: string;
  inReplyTo?: string;
}

export interface ImapPoller {
  start(): void;
  stop(): void;
  pollOnce(): Promise<number>;
}

/**
 * The poll loop is source-agnostic so it can be tested without an IMAP
 * server. IMAP itself has no durable push channel; this is the one place a
 * module-level timer is still appropriate (documented deviation from the
 * scheduler-only timer rule).
 */
export function createImapPoller(args: {
  pull: () => Promise<ImapInbound[]>;
  onMessage: (message: ImapInbound) => Promise<void>;
  intervalMs: number;
  logger: { warn(fields: Record<string, unknown>, message?: string): void };
}): ImapPoller {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  const pollOnce = async (): Promise<number> => {
    if (running) return 0;
    running = true;
    try {
      const messages = await args.pull();
      let delivered = 0;
      for (const message of messages) {
        await args.onMessage(message);
        delivered += 1;
      }
      return delivered;
    } catch (err) {
      args.logger.warn({ err: (err as Error).message }, 'IMAP poll failed');
      return 0;
    } finally {
      running = false;
    }
  };
  return {
    start() {
      if (timer) return;
      void pollOnce();
      timer = setInterval(() => void pollOnce(), Math.max(5_000, args.intervalMs));
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    pollOnce,
  };
}

export interface ImapFlowOptions {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  mailbox: string;
  selfAddresses: string[];
  logger: { warn(fields: Record<string, unknown>, message?: string): void };
}

/** Fetch unseen mail, mark it seen, and map it to the inbound shape. */
export async function pullImapUnseen(options: ImapFlowOptions): Promise<ImapInbound[]> {
  const client = new ImapFlow({
    host: options.host,
    port: options.port,
    secure: options.secure,
    auth: { user: options.user, pass: options.pass },
    logger: false,
  });
  const messages: ImapInbound[] = [];
  await client.connect();
  const lock = await client.getMailboxLock(options.mailbox);
  try {
    for await (const message of client.fetch(
      { seen: false },
      { envelope: true, source: true, uid: true },
    )) {
      const parsed = message.source ? await simpleParser(message.source) : null;
      const from = parsed?.from?.value?.[0]?.address ?? message.envelope?.from?.[0]?.address;
      if (!from || options.selfAddresses.includes(from.toLowerCase())) {
        continue;
      }
      messages.push({
        messageId: parsed?.messageId ?? `imap-${String(message.uid ?? Date.now())}@${options.host}`,
        from,
        subject: parsed?.subject ?? message.envelope?.subject ?? '(no subject)',
        text: parsed?.text ?? '',
        ...(parsed?.inReplyTo ? { inReplyTo: String(parsed.inReplyTo) } : {}),
      });
      await client.messageFlagsAdd(message.uid, ['\\Seen'], { uid: true });
    }
  } finally {
    lock.release();
    await client.logout().catch(() => undefined);
  }
  return messages;
}
