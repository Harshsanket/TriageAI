/**
 * Agent presentation contract (Phase 20.6): stable display names and a
 * categorical colour palette shared by setup, `/config`, runs and dashboards.
 * Names themselves live in `config/agent-names.json` (data, not code).
 */
import { z } from 'zod';

/** Categorical palette validated for light/dark contrast and CVD separation. */
export const AGENT_COLORS = [
  '#3b6fd4',
  '#d9730d',
  '#2f8f6b',
  '#b4467a',
  '#7c5cc4',
  '#a16207',
  '#0e7490',
  '#c2410c',
  '#4d7c0f',
  '#9f1239',
] as const;

export const AgentColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'colour must be a hex value like #3b6fd4');
export type AgentColor = z.infer<typeof AgentColorSchema>;

export const AgentPreferenceSchema = z
  .object({
    /** Interface key the agent belongs to (e.g. chatbot, ticket-solver). */
    interface: z.string().min(1).max(60),
    displayName: z.string().trim().min(1).max(40),
    color: AgentColorSchema,
  })
  .strict();
export type AgentPreference = z.infer<typeof AgentPreferenceSchema>;

export const AgentPreferencesSchema = z.array(AgentPreferenceSchema).max(50).default([]);

export const AgentDefaultsRequestSchema = z.object({
  interfaces: z.array(z.string().min(1)).min(1).max(20),
  existing: z.array(z.string().max(40)).default([]),
  usedColors: z.array(AgentColorSchema).default([]),
});
export type AgentDefaultsRequest = z.input<typeof AgentDefaultsRequestSchema>;

export const AgentDefaultsResponseSchema = z.object({
  agents: z.array(AgentPreferenceSchema),
});
export type AgentDefaultsResponse = z.infer<typeof AgentDefaultsResponseSchema>;

/**
 * Pick the next unused NASA-style name. The list runs out after 24 names, then
 * numbering starts (`Voyager 2`, `Voyager 3`, …). Pure and deterministic.
 */
export function pickAgentName(names: readonly string[], used: Iterable<string>): string {
  const taken = new Set([...used].map((name) => name.trim().toLowerCase()));
  for (const name of names) {
    if (!taken.has(name.toLowerCase())) return name;
  }
  for (let generation = 2; ; generation++) {
    for (const name of names) {
      const candidate = `${name} ${generation}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }
}

/** Next palette colour not already in use, cycling when all are taken. */
export function pickAgentColor(colors: readonly string[], used: Iterable<string>): string {
  const taken = new Set([...used].map((color) => color.toLowerCase()));
  for (const color of colors) {
    if (!taken.has(color.toLowerCase())) return color;
  }
  return colors[0] ?? '#3b6fd4';
}
