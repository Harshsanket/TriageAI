/**
 * Capability adapters for the support profile (Phase 3): HTTP clients to the
 * local ai-service. Selected by `config.capabilities` — never imported by
 * modules directly (they consume `ctx.capabilities`).
 */
import { AiClassifyResponseSchema, AiEmbedResponseSchema } from '@triageai/contracts';
import type {
  Capabilities,
  ClassificationResult,
  EmbedResult,
  KernelConfig,
} from '@triageai/kernel';

const AI_TIMEOUT_MS = 15_000;

export class HttpEmbedder {
  constructor(private readonly baseUrl: string) {}

  async embed(texts: string[]): Promise<EmbedResult> {
    const res = await fetch(`${this.baseUrl}/ai/v1/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ texts }),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`ai-service embed failed (${res.status})`);
    return AiEmbedResponseSchema.parse(await res.json());
  }
}

export class HttpClassifier {
  constructor(private readonly baseUrl: string) {}

  async classify(text: string): Promise<ClassificationResult> {
    const res = await fetch(`${this.baseUrl}/ai/v1/classify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`ai-service classify failed (${res.status})`);
    return AiClassifyResponseSchema.parse(await res.json());
  }
}

export function createCapabilities(config: KernelConfig, fallbackBaseUrl: string): Capabilities {
  const capabilities: Capabilities = {};
  const embedder = config.capabilities.embedder;
  const classifier = config.capabilities.classifier;

  if (embedder) {
    if (embedder.adapter !== 'ai-service') {
      throw new Error(`unsupported embedder adapter "${embedder.adapter}" (supported: ai-service)`);
    }
    capabilities.embedder = new HttpEmbedder(
      (embedder.baseUrl as string | undefined) ?? fallbackBaseUrl,
    );
  }
  if (classifier) {
    if (classifier.adapter !== 'ai-service') {
      throw new Error(
        `unsupported classifier adapter "${classifier.adapter}" (supported: ai-service)`,
      );
    }
    capabilities.classifier = new HttpClassifier(
      (classifier.baseUrl as string | undefined) ?? fallbackBaseUrl,
    );
  }
  return capabilities;
}
