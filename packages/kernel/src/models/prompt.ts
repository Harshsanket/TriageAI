/**
 * Trust-level prompt assembly (Phase 18.10, ADR-0047).
 *
 * Trusted instructions go in the system/developer channel; everything else is
 * data in the user/tool channel, wrapped with a per-call random boundary and
 * provenance. Untrusted content can never become an instruction.
 */
import { randomBytes } from 'node:crypto';

export type TrustLevel = 'trusted_instruction' | 'user_request' | 'untrusted_data' | 'model_output';
export type PromptRole = 'system' | 'developer' | 'user' | 'tool';

export interface PromptPart {
  trust: TrustLevel;
  role: PromptRole;
  source: string;
  content: string;
  sensitivity: 'public' | 'internal' | 'restricted' | 'secret';
  boundary?: string;
}

export interface AssembledMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export function assertTrustBoundary(parts: PromptPart[]): void {
  for (const part of parts) {
    if (
      part.trust === 'trusted_instruction' &&
      part.role !== 'system' &&
      part.role !== 'developer'
    ) {
      throw new Error(`trusted instruction ${part.source} must use the system/developer role`);
    }
    if (
      part.trust !== 'trusted_instruction' &&
      (part.role === 'system' || part.role === 'developer')
    ) {
      throw new Error(`${part.trust} content ${part.source} cannot use the system/developer role`);
    }
  }
}

export function assemblePrompt(parts: PromptPart[]): AssembledMessage[] {
  assertTrustBoundary(parts);
  const boundary = randomBytes(8).toString('hex');
  const messages: AssembledMessage[] = [];
  const instructions = parts.filter((part) => part.trust === 'trusted_instruction');
  const data = parts.filter((part) => part.trust !== 'trusted_instruction');

  if (instructions.length > 0) {
    messages.push({
      role: 'system',
      content: instructions.map((part) => part.content).join('\n\n'),
    });
  }
  for (const part of data) {
    const id = part.source.replace(/[^\w:./#-]/g, '_');
    messages.push({
      role: part.trust === 'user_request' ? 'user' : 'tool',
      content: `<<data id=${id} source=${part.source} trust=${part.trust} boundary=${boundary}>>\n${part.content}\n<<end ${boundary}>>`,
    });
  }
  return messages;
}

/** A structured choice outside the declared labels signals a hijack attempt. */
export function detectHijack(choice: string, labels: string[]): boolean {
  return !labels.includes(choice);
}

/** Markdown rendering policy (18.10): no HTML, no auto-loaded images. */
export function sanitizeModelText(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<img[^>]*>/gi, '[image removed]')
    .replace(/javascript:/gi, '');
}
