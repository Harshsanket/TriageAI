/**
 * Knowledge source seam (Phase 20.2, ADR-0051). A source plugin only *fetches
 * items*; the core pipeline owns dedupe, extraction, chunking and indexing.
 * Two consumers are required before this interface is considered final
 * (ADR-0002): the built-in URL/GitHub sources and a plugin source.
 */
import type { ZodSchema } from 'zod';

import { AppError } from '../errors.js';

export interface KnowledgeSourceItem {
  externalId: string;
  name: string;
  mediaType: string;
  /** Upstream version (commit, ETag, updated-at) when known. */
  contentHash?: string;
  size?: number;
  fetch(): Promise<Uint8Array>;
}

export interface KnowledgeSource {
  /** Stable type id, e.g. `url`, `github`, `acme-drive`. */
  type: string;
  label: string;
  configSchema: ZodSchema;
  /** Items changed since `since` (incremental sync). */
  list(config: Record<string, unknown>, since?: string): AsyncIterable<KnowledgeSourceItem>;
}

export interface KnowledgeSourceRegistry {
  register(source: KnowledgeSource): void;
  get(type: string): KnowledgeSource | undefined;
  list(): KnowledgeSource[];
}

export function createKnowledgeSourceRegistry(): KnowledgeSourceRegistry {
  const sources = new Map<string, KnowledgeSource>();
  return {
    register(source) {
      if (!/^[a-z][a-z0-9-]{1,40}$/.test(source.type)) {
        throw new AppError(
          'kernel.KNOWLEDGE_SOURCE_INVALID',
          `knowledge source type "${source.type}" must be lowercase kebab-case`,
        );
      }
      if (sources.has(source.type)) {
        throw new AppError(
          'kernel.KNOWLEDGE_SOURCE_INVALID',
          `knowledge source "${source.type}" is already registered`,
        );
      }
      sources.set(source.type, source);
    },
    get(type) {
      return sources.get(type);
    },
    list() {
      return [...sources.values()];
    },
  };
}
