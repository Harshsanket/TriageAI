/**
 * Base memory from setup (ADR-0056/0057). The host derives deterministic
 * Markdown from the resolved config and the latest overlay, then writes it
 * through the KB module's system-only managed-source route. No model call is
 * involved; failures are logged/audited but never fail the config change.
 */
import type { Kernel, KernelLogger, KernelRouteDef } from '@triageai/kernel';

import type { SetupRuntime } from '../setup/boot.js';
import { readConnections } from '../routes/connections.js';
import { readSystemStatus, type ConnectedApiFact } from './dashboardReads.js';
import { writeAudit } from './audit.js';

const PUBLIC_KEY = 'base-memory.public';
const OPERATOR_KEY = 'base-memory.operator';
const STATUS_KEY = 'system-status';
const MAX_BYTES = 20 * 1024;

const INTERFACE_DESCRIPTIONS: Record<string, string> = {
  chatbot: 'Holds customer conversations and answers from approved knowledge.',
  'ticket-solver': 'Receives support tickets, routes them and drafts grounded replies.',
  'doc-assistant': 'Answers questions over uploaded project documentation.',
  'notifications-github': 'Mirrors ticket activity into GitHub issues.',
  'notifications-slack': 'Posts routed ticket notifications into Slack channels.',
  emailer: 'Turns inbound email into tickets and sends approved replies.',
  'public-api': 'Serves OpenAI-compatible chat, embeddings and knowledge search to keys.',
};

function clean(value: unknown, max = 300): string {
  return String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email]')
    .replace(/\b(?:bearer|token|secret|password|api[_-]?key)\s*[:=]\s*\S+/gi, '[redacted]')
    .replace(/\b[a-z]+:\/\/[^\s]+@[^\s]+/gi, '[redacted-url]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function hostOf(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

function cap(markdown: string): string {
  if (Buffer.byteLength(markdown, 'utf8') <= MAX_BYTES) return markdown;
  return `${markdown.slice(0, MAX_BYTES - 40)}\n\n_Truncated to the 20 KB cap._\n`;
}

interface OverlayShape {
  interfaces?: string[];
  agents?: Record<string, { displayName?: string; color?: string }>;
}

export interface BaseMemoryDocuments {
  publicDoc: string;
  operatorDoc: string;
}

export function buildBaseMemoryDocuments(args: {
  productName: string;
  overlay: OverlayShape | null;
  enabledModules: string[];
  capabilities: Record<string, { adapter: string; [key: string]: unknown }>;
  profile: string;
  retentionEnabled: boolean;
  knowledge: { documents: number; sources: number; chunks: number } | null;
  connections: ConnectedApiFact[];
  dataPolicy: { activePreset: string | null; customClasses: number } | null;
}): BaseMemoryDocuments {
  const product = clean(args.productName || 'TriageAI', 80);
  const interfaces = args.overlay?.interfaces ?? [];
  const agents = Object.entries(args.overlay?.agents ?? {}).map(([key, agent]) => ({
    key,
    name: clean(agent.displayName ?? key, 40),
    role: INTERFACE_DESCRIPTIONS[key] ?? 'Assists with this installation.',
  }));

  const publicLines = [
    `# About ${product}`,
    '',
    `This installation is ${product}, a self-hosted assistant platform.`,
    '',
    '## Assistants',
    ...(agents.length > 0
      ? [
          '| Name | Role | Used for |',
          '| --- | --- | --- |',
          ...agents.map((agent) => `| ${agent.name} | ${agent.role} | ${clean(agent.key, 60)} |`),
        ]
      : ['No named assistants are configured.']),
    '',
    '## Available interfaces',
    ...(interfaces.length > 0
      ? interfaces.map(
          (key) => `- **${clean(key, 60)}** — ${INTERFACE_DESCRIPTIONS[key] ?? 'Enabled.'}`,
        )
      : ['No customer-facing interfaces are enabled.']),
    '',
    '## Knowledge',
    args.knowledge
      ? `The knowledge base currently holds ${args.knowledge.documents} documents in ${args.knowledge.sources} sources.`
      : 'The knowledge base is not enabled.',
    '',
    'Answers come from approved knowledge sources and cite them where possible.',
  ];

  const runtime =
    args.capabilities.chatModel?.adapter ?? args.capabilities.generator?.adapter ?? 'none';
  const model = args.capabilities.chatModel?.model ?? args.capabilities.generator?.model ?? null;
  const operatorLines = [
    `# ${product} — operator context`,
    '',
    '## Installation',
    `- Profile: ${clean(args.profile, 80)}`,
    `- Enabled modules: ${args.enabledModules.length > 0 ? args.enabledModules.map((id) => clean(id, 60)).join(', ') : 'none'}`,
    `- Retention: ${args.retentionEnabled ? 'enabled' : 'disabled'}`,
    '',
    '## Model runtime',
    `- Adapter: ${clean(runtime, 60)}`,
    `- Model: ${model ? clean(model, 120) : 'not configured'}`,
    '',
    '## Integrations',
    ...(args.connections.length > 0
      ? args.connections.map((connection) => {
          const host = hostOf(connection.baseUrl ?? null);
          return `- ${clean(connection.name, 80)} (${clean(connection.type, 40)}) — ${clean(connection.status, 40)}${host ? ` at ${clean(host, 120)}` : ''}`;
        })
      : ['No external connections are configured.']),
    '',
    '## Knowledge',
    args.knowledge
      ? `- Sources: ${args.knowledge.sources}\n- Documents: ${args.knowledge.documents}\n- Chunks: ${args.knowledge.chunks}`
      : '- The knowledge base is not enabled.',
    '',
    '## Data policy',
    `- Active preset: ${args.dataPolicy?.activePreset ? clean(args.dataPolicy.activePreset, 40) : 'defaults'}`,
    `- Classes with custom retention: ${args.dataPolicy?.customClasses ?? 0}`,
    '',
    '_Generated from setup; not editable. Use Refresh base memory after changing configuration._',
  ];

  return {
    publicDoc: cap(`${publicLines.join('\n')}\n`),
    operatorDoc: cap(`${operatorLines.join('\n')}\n`),
  };
}

export function buildSystemStatusDocument(snapshot: {
  asOf: string;
  database: string;
  health: { status: string; modules: Array<{ id: string; health: string }> };
  queue: { pending: number; processing: number; deadLetters: number };
  activity: { runsLastHour: number; activeRuns: number };
  storage: { totalBytes: number; categories: Array<{ category: string; bytes: number }> } | null;
  cost: { tokensToday: number; callsToday: number; todayUsd: number };
  modelSpeed: { avgLatencyMs: number | null; p95LatencyMs: number | null };
  uptime: {
    systemUptimePct: number;
    services: Array<{ target: string; uptimePct: number; currentOk: boolean | null }>;
  };
  connectedApis: Array<{ name: string; type: string; status: string }>;
}): string {
  const bytes = (value: number): string =>
    value >= 1_000_000_000
      ? `${(value / 1_000_000_000).toFixed(2)} GB`
      : value >= 1_000_000
        ? `${(value / 1_000_000).toFixed(2)} MB`
        : `${Math.round(value / 1000)} KB`;
  const lines = [
    '# System status snapshot',
    '',
    `As of ${snapshot.asOf}`,
    '',
    '## Health',
    `- Overall: ${snapshot.health.status}`,
    `- Database: ${snapshot.database}`,
    ...snapshot.health.modules.map((module) => `- Module ${module.id}: ${module.health}`),
    '',
    '## Queue',
    `- Pending: ${snapshot.queue.pending}`,
    `- Processing: ${snapshot.queue.processing}`,
    `- Dead letters: ${snapshot.queue.deadLetters}`,
    '',
    '## Activity',
    `- Runs in the last hour: ${snapshot.activity.runsLastHour}`,
    `- Active runs: ${snapshot.activity.activeRuns}`,
    '',
    '## Storage',
    ...(snapshot.storage
      ? [
          `- Total: ${bytes(snapshot.storage.totalBytes)}`,
          ...snapshot.storage.categories.map(
            (category) => `- ${category.category}: ${bytes(category.bytes)}`,
          ),
        ]
      : ['- Storage data is unavailable.']),
    '',
    '## Models and cost',
    `- Tokens today: ${snapshot.cost.tokensToday}`,
    `- Model calls today: ${snapshot.cost.callsToday}`,
    `- Estimated spend today: $${snapshot.cost.todayUsd.toFixed(2)}`,
    `- Average latency: ${snapshot.modelSpeed.avgLatencyMs ?? 'n/a'} ms`,
    `- p95 latency: ${snapshot.modelSpeed.p95LatencyMs ?? 'n/a'} ms`,
    '',
    '## Uptime',
    `- System: ${snapshot.uptime.systemUptimePct}%`,
    ...snapshot.uptime.services.map(
      (service) =>
        `- ${service.target}: ${service.uptimePct}% (${service.currentOk === false ? 'down' : 'up'})`,
    ),
    '',
    '## Connected APIs',
    ...(snapshot.connectedApis.length > 0
      ? snapshot.connectedApis.map(
          (api) => `- ${clean(api.name, 80)} (${clean(api.type, 40)}): ${clean(api.status, 40)}`,
        )
      : ['- None configured.']),
    '',
    '_Read-only snapshot. For the current value, call the system status tools._',
  ];
  return cap(`${lines.join('\n')}\n`);
}

export class BaseMemoryService {
  private timer: NodeJS.Timeout | null = null;
  private statusTimer: NodeJS.Timeout | null = null;
  private pending: Promise<void> | null = null;

  constructor(
    private readonly logger: KernelLogger,
    private readonly runtime: SetupRuntime,
  ) {}

  schedule(kernel: Kernel, reason: string): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.sync(kernel, reason);
    }, 400);
    this.timer.unref();
  }

  /**
   * ADR-0057: the operational `system-status` source is a snapshot, so refresh
   * it on the dashboard interval (default 5 min) rather than only on boot or a
   * config change. The timer is unref'd so it cannot hold the process open.
   */
  startPeriodic(getKernel: () => Kernel, intervalMs = 5 * 60_000): void {
    this.stopPeriodic();
    this.statusTimer = setInterval(() => {
      void this.refreshStatus(getKernel()).catch((err: unknown) =>
        this.logger.warn({ err: (err as Error).message }, 'operational memory refresh failed'),
      );
    }, intervalMs);
    this.statusTimer.unref();
  }

  stopPeriodic(): void {
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = null;
  }

  async refreshStatus(kernel: Kernel): Promise<void> {
    if (!kernel.modules.includes('kb')) return;
    const route = kernel
      .routes()
      .find((entry) => entry.method === 'POST' && entry.url === '/api/v1/kb/managed');
    if (!route) return;
    const connections = await readConnections(kernel, this.runtime).catch(() => ({
      connections: [],
      secrets: [],
    }));
    const connectionFacts: ConnectedApiFact[] = connections.connections.map((connection) => ({
      name: connection.name,
      type: connection.type,
      status: connection.status,
      ...(connection.baseUrl ? { baseUrl: connection.baseUrl } : {}),
    }));
    await this.syncStatus(kernel, route, connectionFacts);
  }

  async sync(kernel: Kernel, reason: string): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.doSync(kernel, reason).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async doSync(kernel: Kernel, reason: string): Promise<void> {
    if (!kernel.modules.includes('kb')) return;
    const route = kernel
      .routes()
      .find((entry) => entry.method === 'POST' && entry.url === '/api/v1/kb/managed');
    if (!route) return;
    try {
      const overlay = (await this.runtime.store.latestOverlay())?.overlay as
        OverlayShape | undefined;
      const providers = await kernel.readDashboardProviders().catch(() => []);
      const providerValue = <T>(key: string): T | undefined => {
        for (const provider of providers) {
          if (provider[key] !== undefined) return provider[key] as T;
        }
        return undefined;
      };
      const knowledge = providerValue<{ documents: number }>('knowledge');
      const knowledgePoints =
        providerValue<Array<{ sources: number; documents: number; chunks: number }>>(
          'knowledgePoints',
        );
      const totals = knowledgePoints?.reduce(
        (acc, point) => ({
          sources: acc.sources + point.sources,
          documents: acc.documents + point.documents,
          chunks: acc.chunks + point.chunks,
        }),
        { sources: 0, documents: 0, chunks: 0 },
      );
      const connections = await readConnections(kernel, this.runtime).catch(() => ({
        connections: [],
        secrets: [],
      }));
      const connectionFacts: ConnectedApiFact[] = connections.connections.map((connection) => ({
        name: connection.name,
        type: connection.type,
        status: connection.status,
        ...(connection.baseUrl ? { baseUrl: connection.baseUrl } : {}),
      }));
      const policyRows = await kernel.database
        .query<{ value: { activePreset?: string | null; overrides?: Record<string, unknown> } }>(
          `SELECT value FROM settings WHERE key = 'data-policy'`,
        )
        .catch(() => []);
      const policy = policyRows[0]?.value;
      const docs = buildBaseMemoryDocuments({
        productName: process.env.TRIAGEAI_PRODUCT_NAME ?? 'TriageAI',
        overlay: overlay ?? null,
        enabledModules: kernel.modules,
        capabilities: kernel.config.capabilities,
        profile: kernel.config.profile,
        retentionEnabled: Boolean(kernel.config.retention?.enabled),
        knowledge: knowledge
          ? {
              documents: Number(knowledge.documents),
              sources: Number(totals?.sources ?? 0),
              chunks: Number(totals?.chunks ?? 0),
            }
          : null,
        connections: connectionFacts,
        dataPolicy: policy
          ? {
              activePreset: policy.activePreset ?? null,
              customClasses: Object.keys(policy.overrides ?? {}).length,
            }
          : null,
      });

      for (const [key, body, audience, sensitivity] of [
        [PUBLIC_KEY, docs.publicDoc, 'public', 'public'],
        [OPERATOR_KEY, docs.operatorDoc, 'operator', 'internal'],
      ] as const) {
        await route.handler({
          method: 'POST',
          url: route.url,
          params: {},
          query: {},
          actor: 'system:base-memory',
          body: {
            managedKey: key,
            title: key === PUBLIC_KEY ? 'About this installation' : 'Operator context',
            label: 'Setup context',
            body,
            audience,
            sensitivity,
            readOnly: true,
          },
        });
      }

      await this.syncStatus(kernel, route, connectionFacts);
      await writeAudit(kernel.database, {
        actor: 'system:base-memory',
        action: 'kb.base_memory.sync',
        subject: reason,
        payload: { publicBytes: docs.publicDoc.length, operatorBytes: docs.operatorDoc.length },
      }).catch(() => undefined);
    } catch (err) {
      this.logger.warn(
        { err: (err as Error).message, reason },
        'base memory sync failed; the config change is unaffected',
      );
      await writeAudit(kernel.database, {
        actor: 'system:base-memory',
        action: 'kb.base_memory.sync_failed',
        subject: reason,
        payload: { error: (err as Error).message.slice(0, 300) },
      }).catch(() => undefined);
    }
  }

  private async syncStatus(
    kernel: Kernel,
    route: KernelRouteDef,
    connections: ConnectedApiFact[],
  ): Promise<void> {
    const snapshot = await readSystemStatus(kernel, { connectedApis: connections });
    const body = buildSystemStatusDocument(snapshot);
    await route.handler({
      method: 'POST',
      url: '/api/v1/kb/managed',
      params: {},
      query: {},
      actor: 'system:base-memory',
      body: {
        managedKey: STATUS_KEY,
        title: 'System status snapshot',
        label: 'System status',
        body,
        audience: 'operator',
        sensitivity: 'internal',
        readOnly: true,
      },
    });
  }
}

export { PUBLIC_KEY, OPERATOR_KEY, STATUS_KEY };
