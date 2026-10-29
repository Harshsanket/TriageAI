/**
 * Chat module public DTOs (Phase 4; moved from the module in Phase 10B).
 */
import { z } from 'zod';

export const ChatConversationCreateRequestSchema = z.object({
  title: z.string().max(200).optional(),
});

export const ChatConversationCreatedSchema = z.object({ conversationId: z.string() });

export const ChatConversationSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
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
});
export type ChatConversationDto = z.infer<typeof ChatConversationDtoSchema>;

export const ChatSendMessageRequestSchema = z.object({
  conversationId: z.string().optional(),
  text: z.string().min(1).max(20_000),
});
export type ChatSendMessageRequest = z.infer<typeof ChatSendMessageRequestSchema>;

export const ChatSendMessageResponseSchema = z.object({
  conversationId: z.string(),
  messageId: z.string(),
  runId: z.string(),
});
export type ChatSendMessageResponse = z.infer<typeof ChatSendMessageResponseSchema>;
