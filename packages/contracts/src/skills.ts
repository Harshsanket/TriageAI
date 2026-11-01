/**
 * User skills (ADR-0060): content-only instructions stored per user/instance,
 * merged with the built-in SKILL.md pack. Imported content is never executed.
 */
import { z } from 'zod';

export const SkillScopeSchema = z.enum(['user', 'instance', 'agent']);
export const SkillProvenanceSchema = z.enum(['manual', 'github', 'chat', 'custom', 'suggestion']);

export const UserSkillSchema = z.object({
  id: z.string(),
  ownerId: z.string().nullable(),
  scope: SkillScopeSchema,
  name: z.string(),
  description: z.string(),
  content: z.string(),
  enabled: z.boolean(),
  version: z.number().int().positive(),
  provenance: SkillProvenanceSchema,
  sourceUrl: z.string().nullable(),
  sourceRef: z.string().nullable(),
  license: z.string().nullable(),
  suggestion: z.boolean(),
  ignored: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type UserSkill = z.infer<typeof UserSkillSchema>;

export const SkillListResponseSchema = z.object({
  builtIn: z.array(z.object({ name: z.string(), description: z.string() })).default([]),
  skills: z.array(UserSkillSchema),
  suggestions: z.array(UserSkillSchema).default([]),
});
export type SkillListResponse = z.infer<typeof SkillListResponseSchema>;

export const SkillCreateRequestSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'use lowercase letters, digits and dashes')
      .optional(),
    description: z.string().trim().min(10).max(400),
    instructions: z.string().trim().min(1).max(20_000),
    scope: SkillScopeSchema.default('user'),
    enabled: z.boolean().default(true),
  })
  .strict();
export type SkillCreateRequest = z.input<typeof SkillCreateRequestSchema>;

export const SkillUpdateRequestSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .optional(),
    description: z.string().trim().min(10).max(400).optional(),
    instructions: z.string().trim().min(1).max(20_000).optional(),
    enabled: z.boolean().optional(),
    scope: SkillScopeSchema.optional(),
  })
  .strict();
export type SkillUpdateRequest = z.infer<typeof SkillUpdateRequestSchema>;

export const SkillImportRequestSchema = z.object({ url: z.string().url().max(500) }).strict();

export const SkillSuggestionActionSchema = z.object({ action: z.enum(['accept', 'ignore']) });

export const SkillCaptureResultSchema = z.object({
  captured: z.boolean(),
  kind: z.enum(['explicit', 'suggestion', 'none']),
  skill: UserSkillSchema.nullable().default(null),
  notice: z.string().nullable().default(null),
});
export type SkillCaptureResult = z.infer<typeof SkillCaptureResultSchema>;
