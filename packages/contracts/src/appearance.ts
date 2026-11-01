/** Per-user appearance preferences (Phase 20.7). */
import { z } from 'zod';

import { AgentColorSchema } from './agents.js';

export const AppearanceThemeSchema = z.enum(['light', 'dark', 'auto']);
export type AppearanceTheme = z.infer<typeof AppearanceThemeSchema>;

export const AppearanceFontSizeSchema = z.enum(['small', 'default', 'large', 'xlarge']);
export type AppearanceFontSize = z.infer<typeof AppearanceFontSizeSchema>;

export const AppearanceMotionSchema = z.enum(['on', 'off', 'auto']);
export type AppearanceMotion = z.infer<typeof AppearanceMotionSchema>;

export const AppearancePreferencesSchema = z.object({
  theme: AppearanceThemeSchema.default('auto'),
  fontSize: AppearanceFontSizeSchema.default('default'),
  motion: AppearanceMotionSchema.default('auto'),
});
export type AppearancePreferences = z.infer<typeof AppearancePreferencesSchema>;

export const AppearanceAgentSchema = z.object({
  id: z.string(),
  displayName: z.string().trim().min(1).max(40),
  color: AgentColorSchema,
});
export type AppearanceAgent = z.infer<typeof AppearanceAgentSchema>;

export const UserPreferencesSchema = AppearancePreferencesSchema.extend({
  agents: z.array(AppearanceAgentSchema).max(50).default([]),
  /** Phase 23.3: show the conversation-history sidebar on the home page. */
  chatSidebar: z.boolean().default(false),
});
export type UserPreferences = z.infer<typeof UserPreferencesSchema>;

export const PreferencesResponseSchema = z.object({
  preferences: UserPreferencesSchema,
  /** Admin defaults from the config overlay; null when unset. */
  defaults: AppearancePreferencesSchema.nullable(),
  agents: z.array(AppearanceAgentSchema),
});
export type PreferencesResponse = z.infer<typeof PreferencesResponseSchema>;

export const PreferencesUpdateSchema = AppearancePreferencesSchema.partial()
  .extend({
    agents: z.array(AppearanceAgentSchema).max(50).optional(),
    chatSidebar: z.boolean().optional(),
  })
  .strict();
export type PreferencesUpdate = z.infer<typeof PreferencesUpdateSchema>;

export const AppearanceDefaultsUpdateSchema = AppearancePreferencesSchema.partial().strict();
export type AppearanceDefaultsUpdate = z.infer<typeof AppearanceDefaultsUpdateSchema>;
