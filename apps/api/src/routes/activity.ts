/**
 * Activity search (Phase 18.6): a deterministic filter first, one small-model
 * call only when the phrase needs it, then a parameterised activity query.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { ActivityQuerySchema, type ActivityQuery } from '@triageai/contracts';
import {
  queryActivity,
  resolveActivityQuery,
  type ActivityQueryResolution,
} from '@triageai/kernel';
import type { ChatModel, Kernel } from '@triageai/kernel';

import { buildChatModel } from '../services/chatModels.js';
import { getControls } from '../services/controls.js';

const isoDate = z
  .string()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), 'must be an ISO date');

const ActivityListQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(500).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    kinds: z.union([z.string(), z.array(z.string())]).optional(),
    actors: z.union([z.string(), z.array(z.string())]).optional(),
    text: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();

function list(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const items = (Array.isArray(value) ? value : [value])
    .flatMap((item) => item.split(','))
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

/**
 * The route uses the kernel's injected capability when the host supplies one.
 * Otherwise it builds the configured *local* adapter: activity is restricted
 * data, so a hosted model must never receive it (18.8 send gate).
 */
export interface ActivityRouteDeps {
  chatModel?: ChatModel;
}

let modelCache: { key: string; model: ChatModel | undefined } | null = null;

function configuredModel(kernel: Kernel): ChatModel | undefined {
  const cfg = kernel.config.capabilities.chatModel as Record<string, unknown> | undefined;
  const key = JSON.stringify({
    adapter: cfg?.adapter ?? null,
    model: cfg?.model ?? null,
    baseUrl: cfg?.baseUrl ?? null,
  });
  if (modelCache?.key === key) return modelCache.model;
  const adapter = String(cfg?.adapter ?? '');
  const model = String(cfg?.model ?? '');
  const local = ['ollama', 'lmstudio', 'openai_compatible_local'];
  const built =
    cfg && model && local.includes(adapter)
      ? buildChatModel({
          adapter,
          model,
          baseUrl: cfg.baseUrl as string | undefined,
        })
      : undefined;
  modelCache = { key, model: built };
  return built;
}

function rangeFromParams(parsed: z.infer<typeof ActivityListQuerySchema>): {
  from: string;
  to: string;
} {
  const now = new Date();
  const from = parsed.from
    ? new Date(parsed.from)
    : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const to = parsed.to ? new Date(parsed.to) : now;
  return { from: from.toISOString(), to: to.toISOString() };
}

export function registerActivityRoutes(
  app: FastifyInstance,
  kernel: Kernel,
  deps: ActivityRouteDeps = {},
): void {
  app.get('/api/v1/activity', async (request) => {
    const parsed = ActivityListQuerySchema.parse(request.query ?? {});
    const limit = parsed.limit ?? 100;
    let resolution: ActivityQueryResolution;
    if (parsed.q) {
      const controls = await getControls(kernel.database);
      resolution = await resolveActivityQuery({
        phrase: parsed.q,
        chatModel: deps.chatModel ?? configuredModel(kernel),
        llmDisabled: controls.llmDisabled,
      });
    } else {
      const kinds = list(parsed.kinds);
      const actors = list(parsed.actors);
      const query: ActivityQuery = ActivityQuerySchema.parse({
        timeRange: rangeFromParams(parsed),
        ...(kinds ? { kinds } : {}),
        ...(actors ? { actors } : {}),
        ...(parsed.text ? { text: parsed.text } : {}),
      });
      resolution = { query, source: 'deterministic' };
    }
    const events = await queryActivity(kernel.database, resolution.query, limit);
    return { source: resolution.source, query: resolution.query, events };
  });
}
