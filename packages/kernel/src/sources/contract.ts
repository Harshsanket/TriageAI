/**
 * Contract suite for KnowledgeSource implementations (Phase 20.2). Adapters
 * import this from their own tests so a plugin cannot ship a source that only
 * looks like one.
 */
import type { KnowledgeSource } from './registry.js';

export interface SourceContractCase {
  config: Record<string, unknown>;
  expectedItems: Array<{ name: string; mediaType: string }>;
}

export async function runKnowledgeSourceContract(
  source: KnowledgeSource,
  cases: SourceContractCase[],
): Promise<void> {
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(source.type)) {
    throw new Error(`invalid source type: ${source.type}`);
  }
  if (!source.label?.trim()) throw new Error('source.label is required');
  if (!source.configSchema) throw new Error('source.configSchema is required');
  if (!source.list) throw new Error('source.list is required');
  for (const testCase of cases) {
    const parsed = source.configSchema.safeParse(testCase.config);
    if (!parsed.success) {
      throw new Error(`config rejected for ${source.type}: ${parsed.error.message}`);
    }
    const seen: Array<{ name: string; mediaType: string }> = [];
    for await (const item of source.list(testCase.config)) {
      if (!item.externalId) throw new Error('item.externalId is required');
      if (!item.name) throw new Error('item.name is required');
      if (!item.mediaType) throw new Error('item.mediaType is required');
      const bytes = await item.fetch();
      if (!(bytes instanceof Uint8Array)) throw new Error('item.fetch() must return bytes');
      seen.push({ name: item.name, mediaType: item.mediaType });
    }
    if (JSON.stringify(seen) !== JSON.stringify(testCase.expectedItems)) {
      throw new Error(
        `source ${source.type} yielded ${JSON.stringify(seen)}; expected ${JSON.stringify(testCase.expectedItems)}`,
      );
    }
  }
}
