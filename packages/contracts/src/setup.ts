/**
 * First-run setup wizard DTOs (Phase 11, ADR-0024). The wizard's answers are
 * turned into a config overlay by the API; the web host and tests share these.
 */
import { z } from 'zod';

export const SetupStateSchema = z.enum(['pending', 'applied', 'complete']);
export type SetupState = z.infer<typeof SetupStateSchema>;

export const SetupStatusSchema = z.object({
  state: SetupStateSchema,
  /** Pending setup is authorised with the one-time token from the API log. */
  tokenRequired: z.boolean(),
  /** Answers were applied; the API must restart to boot them (until Phase 12). */
  restartRequired: z.boolean(),
  lastError: z.string().nullable(),
  overlayVersion: z.number().int().nullable(),
  secretStoreAvailable: z.boolean(),
});
export type SetupStatus = z.infer<typeof SetupStatusSchema>;

/** Interfaces the wizard offers. `public-api` and `emailer` arrive in Phase 13. */
export const SetupInterfaceSchema = z.enum([
  'chatbot',
  'ticket-solver',
  'doc-assistant',
  'notifications-github',
  'notifications-slack',
]);
export type SetupInterface = z.infer<typeof SetupInterfaceSchema>;

export const LlmRuntimeSchema = z.enum(['ollama', 'lmstudio', 'openai-compatible', 'none']);
export type LlmRuntime = z.infer<typeof LlmRuntimeSchema>;

export const SetupDocumentSchema = z.object({
  title: z.string().min(1).max(300),
  body: z.string().min(1).max(200_000),
  source: z.string().min(1).max(300).default('setup-upload'),
});

export const SetupAnswersSchema = z.object({
  interfaces: z.array(SetupInterfaceSchema).min(1).max(5),
  knowledge: z
    .object({
      autoApprove: z.boolean().default(false),
      documents: z.array(SetupDocumentSchema).max(50).default([]),
    })
    .default({}),
  llm: z
    .object({
      runtime: LlmRuntimeSchema,
      baseUrl: z.string().url().optional(),
      model: z.string().min(1).max(300).optional(),
    })
    .superRefine((llm, ctx) => {
      if (llm.runtime !== 'none' && !llm.model) {
        ctx.addIssue({ code: 'custom', path: ['model'], message: 'pick a model for this runtime' });
      }
    }),
  ticketSolver: z.object({ autoReply: z.boolean().default(true) }).default({}),
  integrations: z
    .object({
      githubRepo: z
        .string()
        .regex(/^[\w.-]+\/[\w.-]+$/, 'repo must be owner/name')
        .optional(),
      /** Stored encrypted in the secret store, never in the overlay. */
      githubToken: z.string().min(1).max(500).optional(),
      slackWebhookUrl: z.string().url().optional(),
    })
    .default({}),
  access: z
    .object({
      authMode: z.enum(['disabled', 'required']).default('disabled'),
      admin: z
        .object({
          email: z.string().trim().toLowerCase().email().max(320),
          password: z.string().min(10).max(200),
          name: z.string().trim().min(1).max(120),
        })
        .optional(),
    })
    .default({}),
});
export type SetupAnswers = z.input<typeof SetupAnswersSchema>;
export type ParsedSetupAnswers = z.infer<typeof SetupAnswersSchema>;

export const SetupPlanSchema = z.object({
  overlay: z.record(z.unknown()),
  enabledModules: z.array(z.string()),
  /** Blocking: the config would not boot. */
  problems: z.array(z.string()),
  /** Non-blocking: worth reading before applying. */
  warnings: z.array(z.string()),
  secrets: z.array(z.string()),
});
export type SetupPlan = z.infer<typeof SetupPlanSchema>;

export const HardwareProfileSchema = z.object({
  platform: z.string(),
  arch: z.string(),
  cpuModel: z.string(),
  cpuCores: z.number().int(),
  memoryTotalBytes: z.number(),
  memoryFreeBytes: z.number(),
  appleSilicon: z.boolean(),
  gpu: z
    .object({
      kind: z.enum(['cuda', 'mps', 'none']),
      name: z.string().nullable(),
      memoryBytes: z.number().nullable(),
    })
    .nullable(),
  diskFreeBytes: z.number().nullable(),
  /** Memory a local model may use, after OS/app headroom. */
  modelBudgetBytes: z.number(),
  tier: z.enum(['small', 'medium', 'large']),
  services: z.object({
    aiService: z.boolean(),
    ollama: z.boolean(),
  }),
});
export type HardwareProfile = z.infer<typeof HardwareProfileSchema>;

export const ModelFitSchema = z.enum(['fits', 'tight', 'too-large', 'unknown']);

export const CatalogModelSchema = z.object({
  id: z.string(),
  kind: z.enum(['generation', 'embedding']),
  /** What to put in config / pass to the runtime (e.g. `hf.co/owner/repo:Q4_K_M`). */
  runtimeModel: z.string(),
  sizeBytes: z.number().nullable(),
  fit: ModelFitSchema,
  license: z.string().nullable(),
  gated: z.boolean(),
  downloads: z.number().nullable(),
  contextLength: z.number().nullable(),
  source: z.enum(['preset', 'huggingface']),
  note: z.string().nullable(),
});
export type CatalogModel = z.infer<typeof CatalogModelSchema>;
