/**
 * Module Protocol v1 (MP1, ADR-0055). JSON-RPC 2.0 framing with one strict
 * envelope; payload schemas are registered by exactly one owner and exported
 * as JSON Schema for the Python SDK.
 */
import { z } from 'zod';

import { ErrorEnvelopeSchema } from './errors.js';

export const Mp1DataClassSchema = z.enum(['public', 'internal', 'restricted', 'secret']);
export type Mp1DataClass = z.infer<typeof Mp1DataClassSchema>;

export const Mp1PrincipalSchema = z
  .string()
  .regex(
    /^(core|module:[a-z0-9-]+@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?|agent:[a-z0-9-]+(?:@\d+\.\d+\.\d+)?\/module:[a-z0-9-]+|external:[A-Za-z0-9._:-]+)$/,
    'invalid MP1 principal',
  );
export type Mp1Principal = z.infer<typeof Mp1PrincipalSchema>;

export const Mp1TargetSchema = z
  .string()
  .regex(
    /^(core|capability:[a-z][a-z0-9.-]*|event:[a-z][a-z0-9.-]*|task:[A-Za-z0-9._:-]+|module:[a-z0-9-]+(?:@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)?)$/,
    'invalid MP1 target',
  );
export type Mp1Target = z.infer<typeof Mp1TargetSchema>;

export const Mp1OpSchema = z.enum([
  'handshake',
  'health',
  'drain',
  'stop',
  'stage.invoke',
  'route.handle',
  'event.publish',
  'event.deliver',
  'capability.call',
  'capability.serve',
  'task.create',
  'task.update',
  'task.get',
  'runs.get',
  'runs.list',
  'knowledge.query',
  'progress.report',
  'audit.append',
  'log',
]);
export type Mp1Op = z.infer<typeof Mp1OpSchema>;

export const Mp1KindSchema = z.enum(['request', 'response', 'event', 'stream', 'cancel']);

export const Mp1SchemaIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9.-]*@\d+$/, 'schema must be <id>@<major>');

const IsoDateSchema = z.string().datetime({ offset: true });
const MAX_PAYLOAD_KEYS = 200;

export const Mp1EnvelopeSchema = z
  .object({
    mp: z.literal('1.0'),
    id: z.string().min(1).max(64),
    kind: Mp1KindSchema,
    op: Mp1OpSchema,
    from: Mp1PrincipalSchema,
    to: Mp1TargetSchema,
    schema: Mp1SchemaIdSchema,
    correlationId: z.string().min(1).max(64).optional(),
    runId: z.string().min(1).max(64).optional(),
    idempotencyKey: z.string().min(1).max(200).optional(),
    deadline: IsoDateSchema,
    dataClass: Mp1DataClassSchema,
    payload: z.unknown(),
    coreSig: z.string().min(1).max(4096).optional(),
    error: ErrorEnvelopeSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === 'request' && value.op === 'stage.invoke' && !value.idempotencyKey) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['idempotencyKey'],
        message: 'stage.invoke requires an idempotencyKey',
      });
    }
    if (value.kind === 'response' && !value.correlationId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['correlationId'],
        message: 'responses carry the request id in correlationId',
      });
    }
    const payload = value.payload;
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const keys = Object.keys(payload);
      if (keys.length > MAX_PAYLOAD_KEYS) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['payload'],
          message: `payload has more than ${MAX_PAYLOAD_KEYS} keys`,
        });
      }
    }
  });
export type Mp1Envelope = z.infer<typeof Mp1EnvelopeSchema>;

// ── Payload schemas (one owner per id) ───────────────────────────────────────

export const Mp1EmptyPayloadSchema = z.object({}).strict();

export const Mp1HandshakePayloadSchema = z
  .object({
    mp: z.literal('1.0'),
    moduleId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    version: z.string().min(1).max(64),
    schemas: z.array(Mp1SchemaIdSchema).max(200),
    runMode: z.enum(['in-process', 'worker', 'container']),
  })
  .strict();
export type Mp1HandshakePayload = z.infer<typeof Mp1HandshakePayloadSchema>;

export const Mp1StageInvokePayloadSchema = z
  .object({
    runId: z.string().min(1).max(64),
    workflowId: z.string().min(1).max(200),
    stageId: z.string().min(1).max(200),
    kind: z.string().min(1).max(200),
    config: z.record(z.string(), z.unknown()).default({}),
    input: z.record(z.string(), z.unknown()).default({}),
    data: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type Mp1StageInvokePayload = z.infer<typeof Mp1StageInvokePayloadSchema>;

export const Mp1StageResultSchema = z
  .object({
    output: z.unknown().optional(),
    evidence: z.record(z.string(), z.unknown()).optional(),
    deterministic: z.record(z.string(), z.unknown()).nullable().optional(),
    fallback: z.record(z.string(), z.unknown()).nullable().optional(),
    adapterVersions: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const Mp1RouteHandlePayloadSchema = z
  .object({
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']),
    url: z.string().startsWith('/').max(2048),
    params: z.record(z.string(), z.string()).default({}),
    query: z.record(z.string(), z.string()).default({}),
    body: z.unknown(),
    actor: z.string().max(200).optional(),
    actorId: z.string().max(200).optional(),
    role: z.string().max(50).optional(),
    ownerScope: z.string().max(200).optional(),
  })
  .strict();

export const Mp1EventPublishPayloadSchema = z
  .object({
    event: z.string().min(3).max(200),
    payload: z.unknown(),
  })
  .strict();

export const Mp1EventDeliverPayloadSchema = Mp1EventPublishPayloadSchema;

export const Mp1CapabilityCallPayloadSchema = z
  .object({
    capability: z.string().min(1).max(100),
    args: z.unknown(),
  })
  .strict();

export const Mp1RunsGetPayloadSchema = z.object({ id: z.string().min(1).max(64) }).strict();
export const Mp1RunsListPayloadSchema = z
  .object({
    workflowId: z.string().max(200).optional(),
    status: z.array(z.string().max(40)).max(20).optional(),
    inputMatch: z.record(z.string(), z.string()).optional(),
    ownerId: z.string().max(200).optional(),
    limit: z.number().int().positive().max(200).optional(),
  })
  .strict();

export const Mp1KnowledgeQueryPayloadSchema = z
  .object({
    collection: z.string().min(1).max(200),
    mode: z.enum(['read', 'write']),
    operation: z.enum(['stats', 'hasRows', 'delete', 'dailyCounts', 'storageStats']),
    days: z.number().int().positive().max(90).optional(),
  })
  .strict();

export const Mp1ProgressPayloadSchema = z
  .object({
    runId: z.string().min(1).max(64),
    update: z.record(z.string(), z.unknown()),
  })
  .strict();

export const Mp1AuditAppendPayloadSchema = z
  .object({
    action: z.string().min(1).max(200),
    subject: z.string().max(200).nullish(),
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const Mp1LogPayloadSchema = z
  .object({
    level: z.enum(['info', 'warn', 'error']),
    message: z.string().max(2000),
    fields: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const Mp1TaskCreatePayloadSchema = z
  .object({
    taskId: z.string().min(1).max(64),
    workspaceId: z.string().min(1).max(64),
    rootRunId: z.string().min(1).max(64).optional(),
    title: z.string().min(1).max(200),
    doneWhen: z.string().min(1).max(500),
    inputRefs: z.array(z.string().max(200)).max(50).default([]),
  })
  .strict();

export const Mp1TaskUpdatePayloadSchema = z
  .object({
    taskId: z.string().min(1).max(64),
    status: z.enum(['created', 'working', 'input-required', 'done', 'failed', 'cancelled']),
    proofRefs: z.array(z.string().max(200)).max(50).optional(),
    agentId: z.string().max(100).optional(),
  })
  .strict();

export const Mp1TaskGetPayloadSchema = z.object({ taskId: z.string().min(1).max(64) }).strict();

/** Schema registry: `<id>@<major>` → owner + validator. */
export const MP1_PAYLOAD_SCHEMAS: Record<string, { owner: 'core' | string; schema: z.ZodTypeAny }> =
  {
    'mp1.response@1': { owner: 'core', schema: z.unknown() },
    'mp1.health@1': { owner: 'core', schema: Mp1EmptyPayloadSchema },
    'mp1.drain@1': { owner: 'core', schema: Mp1EmptyPayloadSchema },
    'mp1.stop@1': { owner: 'core', schema: Mp1EmptyPayloadSchema },
    'mp1.handshake@1': { owner: 'core', schema: Mp1HandshakePayloadSchema },
    'mp1.stage.invoke@1': { owner: 'core', schema: Mp1StageInvokePayloadSchema },
    'mp1.stage.result@1': { owner: 'core', schema: Mp1StageResultSchema },
    'mp1.route.handle@1': { owner: 'core', schema: Mp1RouteHandlePayloadSchema },
    'mp1.event.publish@1': { owner: 'core', schema: Mp1EventPublishPayloadSchema },
    'mp1.event.deliver@1': { owner: 'core', schema: Mp1EventDeliverPayloadSchema },
    'mp1.capability.call@1': { owner: 'core', schema: Mp1CapabilityCallPayloadSchema },
    'mp1.runs.get@1': { owner: 'core', schema: Mp1RunsGetPayloadSchema },
    'mp1.runs.list@1': { owner: 'core', schema: Mp1RunsListPayloadSchema },
    'mp1.knowledge.query@1': { owner: 'core', schema: Mp1KnowledgeQueryPayloadSchema },
    'mp1.progress.report@1': { owner: 'core', schema: Mp1ProgressPayloadSchema },
    'mp1.audit.append@1': { owner: 'core', schema: Mp1AuditAppendPayloadSchema },
    'mp1.log@1': { owner: 'core', schema: Mp1LogPayloadSchema },
    'mp1.task.create@1': { owner: 'core', schema: Mp1TaskCreatePayloadSchema },
    'mp1.task.update@1': { owner: 'core', schema: Mp1TaskUpdatePayloadSchema },
    'mp1.task.get@1': { owner: 'core', schema: Mp1TaskGetPayloadSchema },
  };

export function mp1PayloadSchema(id: string): z.ZodTypeAny | undefined {
  return MP1_PAYLOAD_SCHEMAS[id]?.schema;
}

/** Validate an envelope and its payload against the registered schema. */
export function parseMp1Envelope(
  input: unknown,
): { ok: true; envelope: Mp1Envelope } | { ok: false; issues: z.ZodIssue[] } {
  const envelope = Mp1EnvelopeSchema.safeParse(input);
  if (!envelope.success) return { ok: false, issues: envelope.error.issues };
  const schema = mp1PayloadSchema(envelope.data.schema);
  if (!schema) {
    return {
      ok: false,
      issues: [
        {
          code: z.ZodIssueCode.custom,
          path: ['schema'],
          message: `unknown MP1 schema ${envelope.data.schema}`,
        },
      ],
    };
  }
  const payload = schema.safeParse(envelope.data.payload);
  if (!payload.success) return { ok: false, issues: payload.error.issues };
  return { ok: true, envelope: envelope.data };
}
