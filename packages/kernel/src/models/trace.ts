/** OpenTelemetry mapping for ModelCallTrace (Phase 18.4/18.T30). */
import { createHash } from 'node:crypto';

import type { ModelCallTrace } from './callModel.js';

export type CaptureMode = 'off' | 'redacted' | 'full';

export interface OtelSpan {
  name: string;
  attributes: Record<string, string | number | boolean>;
}

export function toOtelSpan(trace: ModelCallTrace, capture: CaptureMode = 'redacted'): OtelSpan {
  const attributes: Record<string, string | number | boolean> = {
    'gen_ai.system': trace.provider,
    'gen_ai.request.model': trace.modelName,
    'gen_ai.response.model': trace.modelVersion,
    'gen_ai.usage.input_tokens': trace.tokensIn,
    'gen_ai.usage.output_tokens': trace.tokensOut,
    'gen_ai.usage.cached_tokens': trace.tokensCached,
    'gen_ai.response.finish_reasons': trace.responseFinishReason ?? 'end',
    'triageai.run_id': trace.runId,
    'triageai.workflow_id': trace.workflowId,
    'triageai.step_name': trace.stepName,
    'triageai.task': trace.task,
    'triageai.latency_ms': trace.latencyMs,
    'triageai.prompt_hash': trace.promptHash,
    'triageai.retries': trace.retries,
    'triageai.fallback_used': trace.fallbackUsed,
  };
  if (trace.errorCategory) attributes['triageai.error_category'] = trace.errorCategory;
  if (trace.errorCode) attributes['triageai.error_code'] = trace.errorCode;
  if (capture === 'full' && trace.promptText) attributes['triageai.prompt_text'] = trace.promptText;
  if (capture === 'redacted') attributes['triageai.prompt_capture'] = 'redacted';
  if (capture === 'off') attributes['triageai.prompt_capture'] = 'off';
  return { name: `gen_ai.${trace.task}`, attributes };
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Array<{
    key: string;
    value: { stringValue: string } | { intValue: number } | { boolValue: boolean };
  }>;
  status: { code: number };
}

/** Minimal OTLP/JSON span payload (18.4); the exporter is optional and off by default. */
export function toOtlpSpan(trace: ModelCallTrace, capture: CaptureMode = 'redacted'): OtlpSpan {
  const span = toOtelSpan(trace, capture);
  const start = Date.parse(trace.at);
  const end = start + trace.latencyMs;
  const traceId = createHash('sha256').update(trace.traceId).digest('hex').slice(0, 32);
  const spanId = createHash('sha256').update(`${trace.traceId}:span`).digest('hex').slice(0, 16);
  return {
    traceId,
    spanId,
    name: span.name,
    kind: 3,
    startTimeUnixNano: `${start}000000`,
    endTimeUnixNano: `${end}000000`,
    attributes: Object.entries(span.attributes).map(([key, value]) => ({
      key,
      value:
        typeof value === 'number'
          ? { intValue: value }
          : typeof value === 'boolean'
            ? { boolValue: value }
            : { stringValue: value },
    })),
    status: { code: trace.errorCode ? 2 : 1 },
  };
}

export async function exportOtlpTrace(
  trace: ModelCallTrace,
  endpoint: string,
  capture: CaptureMode = 'redacted',
  egress?: {
    fetch(url: string, init: RequestInit, context: { purpose: string }): Promise<Response>;
  },
): Promise<void> {
  const payload = {
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: 'service.name', value: { stringValue: 'triageai' } }],
        },
        scopeSpans: [
          {
            scope: { name: 'triageai.models', version: '1.0.0' },
            spans: [toOtlpSpan(trace, capture)],
          },
        ],
      },
    ],
  };
  if (!egress) return;
  await egress.fetch(
    `${endpoint.replace(/\/$/, '')}/v1/traces`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    },
    { purpose: 'otlp.export' },
  );
}
