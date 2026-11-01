import { describe, expect, it } from 'vitest';

import { toOtelSpan, toOtlpSpan } from '../src/models/trace.js';
import type { ModelCallTrace } from '../src/models/callModel.js';

const trace: ModelCallTrace = {
  traceId: 't1',
  runId: 'r1',
  workflowId: 'w',
  workflowVersion: '1',
  stepName: 'generate',
  task: 'answer',
  provider: 'fake',
  modelName: 'm',
  modelVersion: 'm-1',
  routingReason: 'primary',
  promptTemplateId: 'p',
  promptVersion: '1',
  promptHash: 'h',
  promptText: 'secret prompt',
  toolCalls: [],
  latencyMs: 12,
  tokensIn: 5,
  tokensOut: 3,
  tokensCached: 0,
  estCost: 0,
  currency: 'USD',
  retries: 0,
  fallbackUsed: 'none',
  schemaValidFirstTry: true,
  qualityChecks: [],
  securityEvents: [],
  at: '2026-10-30T00:00:00Z',
};

describe('ModelCallTrace -> OTel span (phase 18.4)', () => {
  it('maps GenAI semantic attributes and honours the capture switch', () => {
    expect(toOtelSpan(trace, 'off').attributes).toMatchObject({
      'gen_ai.system': 'fake',
      'gen_ai.usage.input_tokens': 5,
      'triageai.prompt_capture': 'off',
    });
    expect(toOtelSpan(trace, 'off').attributes['triageai.prompt_text']).toBeUndefined();
    expect(toOtelSpan(trace, 'full').attributes['triageai.prompt_text']).toBe('secret prompt');
    expect(toOtelSpan(trace, 'redacted').attributes['triageai.prompt_text']).toBeUndefined();
  });

  it('maps to a valid OTLP/JSON span with hex ids and nanosecond times', () => {
    const span = toOtlpSpan(trace, 'off');
    expect(span.traceId).toMatch(/^[a-f0-9]{32}$/);
    expect(span.spanId).toMatch(/^[a-f0-9]{16}$/);
    expect(span.startTimeUnixNano).toMatch(/^\d{19}$/);
    expect(span.attributes.find((attr) => attr.key === 'gen_ai.system')?.value).toEqual({
      stringValue: 'fake',
    });
    expect(span.status.code).toBe(1);
  });
});
