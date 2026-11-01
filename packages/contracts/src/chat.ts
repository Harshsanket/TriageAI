/**
 * Chat module public DTOs (Phase 4; moved from the module in Phase 10B).
 */
import { z } from 'zod';

export const ChatConversationCreateRequestSchema = z.object({
  title: z.string().max(200).optional(),
});

export const ChatConversationCreatedSchema = z.object({ conversationId: z.string() });

export const ChatContextSchema = z.object({
  usedTokens: z.number().nonnegative(),
  totalTokens: z.number().positive(),
  availableTokens: z.number().nonnegative().optional(),
  percent: z.number().min(0).max(100),
  highWaterPercent: z.number().min(0).max(100).optional(),
  compacted: z.boolean().default(false),
  degraded: z.boolean().default(false),
  summaryVersion: z.number().int().nonnegative().default(0),
  droppedTurns: z.number().int().nonnegative().default(0),
  measuredAt: z.string(),
});
export type ChatContext = z.infer<typeof ChatContextSchema>;

export const ChatConversationSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  pinned: z.boolean().default(false),
  summary: z.string().nullable().optional(),
  lastMessage: z.string().nullable().optional(),
  context: ChatContextSchema.nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ChatConversationSummary = z.infer<typeof ChatConversationSummarySchema>;

export const ChatMessageDtoSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  citations: z.array(z.string()),
  createdAt: z.string(),
});
export type ChatMessageDto = z.infer<typeof ChatMessageDtoSchema>;

export const ChatConversationDtoSchema = z.object({
  conversationId: z.string(),
  messages: z.array(ChatMessageDtoSchema),
  context: ChatContextSchema.nullable().optional(),
  nextCursor: z.string().nullable().optional(),
});
export type ChatConversationDto = z.infer<typeof ChatConversationDtoSchema>;

export const ChatSendMessageRequestSchema = z.object({
  conversationId: z.string().optional(),
  text: z.string().min(1).max(20_000),
});
export type ChatSendMessageRequest = z.infer<typeof ChatSendMessageRequestSchema>;

export const ChatConversationPatchSchema = z
  .object({ title: z.string().min(1).max(80).optional(), pinned: z.boolean().optional() })
  .strict();

export const ChatSendMessageResponseSchema = z.object({
  conversationId: z.string(),
  messageId: z.string(),
  runId: z.string(),
});
export type ChatSendMessageResponse = z.infer<typeof ChatSendMessageResponseSchema>;
