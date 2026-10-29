/** Module options (`modules.support.options`), validated at register time. */
import { z } from 'zod';

import { TicketPriorityCodeSchema } from '@triageai/contracts';

import { DEFAULT_PRIORITY_SIGNALS, DEFAULT_TEAM_MAPPINGS } from './triage.js';

export const triageConfigSchema = z
  .object({
    prioritySignals: z
      .object({
        P0: z.array(z.string().min(1)).default(DEFAULT_PRIORITY_SIGNALS.P0),
        P1: z.array(z.string().min(1)).default(DEFAULT_PRIORITY_SIGNALS.P1),
        P2: z.array(z.string().min(1)).default(DEFAULT_PRIORITY_SIGNALS.P2),
        P3: z.array(z.string().min(1)).default(DEFAULT_PRIORITY_SIGNALS.P3),
      })
      .default(DEFAULT_PRIORITY_SIGNALS),
    teamMappings: z
      .array(
        z.object({
          teamId: z.string().min(1).max(100),
          categories: z.array(z.string().min(1)).default([]),
          priorities: z.array(TicketPriorityCodeSchema).optional(),
        }),
      )
      .default(DEFAULT_TEAM_MAPPINGS),
    // Policy default for tickets with no signal. Set to null for a strict
    // profile where every unmatched ticket goes to manual triage.
    fallbackPriorityCode: TicketPriorityCodeSchema.nullable().default('P3'),
  })
  .default({});

export const configSchema = z
  .object({
    defaultMaxAnswerChars: z.number().int().positive().max(20_000).default(1200),
    defaultCollection: z.string().default('kb_docs'),
    triage: triageConfigSchema,
  })
  .strict();

export type SupportOptions = z.infer<typeof configSchema>;
