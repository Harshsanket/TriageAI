/**
 * Echo container entrypoint (Phase 22.T8): the same reference module, reached
 * over MP1 instead of in-process. The core's supervisor performs the handshake
 * and sends `stage.invoke`; this server never touches the queue or core tables.
 */
import type { Mp1StageInvokePayload } from '@triageai/contracts';
import { internal, startMp1HttpServer } from '@triageai/kernel';

const MODULE_ID = 'echo';
const VERSION = '0.1.0';
const PORT = Number(process.env.TRIAGEAI_MP1_PORT ?? 8080);

const server = await startMp1HttpServer({
  moduleId: MODULE_ID,
  version: VERSION,
  port: PORT,
  requireSession: process.env.TRIAGEAI_MP1_REQUIRE_SESSION === '1',
  ...(process.env.TRIAGEAI_CORE_PUBLIC_KEY
    ? { corePublicKeyBase64: process.env.TRIAGEAI_CORE_PUBLIC_KEY }
    : {}),
  ...(process.env.TRIAGEAI_SESSION_PUBLIC_KEY
    ? {
        sessionPublicKeyBase64: process.env.TRIAGEAI_SESSION_PUBLIC_KEY,
        sessionGeneration: process.env.TRIAGEAI_SESSION_GENERATION,
      }
    : {}),
  handlers: {
    async handshake() {
      return {
        mp: '1.0',
        moduleId: MODULE_ID,
        version: VERSION,
        schemas: ['mp1.handshake@1', 'mp1.stage.invoke@1', 'mp1.response@1'],
        runMode: 'container',
      };
    },
    async health() {
      return { status: 'healthy' };
    },
    async drain() {
      return { drained: true };
    },
    async stop() {
      return { stopped: true };
    },
    async 'stage.invoke'(raw) {
      const payload = raw as Mp1StageInvokePayload;
      const data = (payload.data.input ?? payload.input) as { text?: string };
      const text = String(data.text ?? '');
      if (payload.kind === 'echo.upper') {
        return {
          output: { upper: text.toUpperCase() },
          evidence: { kind: 'deterministic', values: { policy: 'upper' } },
          deterministic: { text },
        };
      }
      if (payload.kind === 'echo.wrap') {
        const upper = String((payload.data.upper as { upper?: string } | undefined)?.upper ?? '');
        return {
          output: { wrapped: `[${upper}]` },
          evidence: { kind: 'deterministic', values: { policy: 'wrap' } },
          deterministic: { upper },
        };
      }
      throw internal(`unsupported echo stage ${payload.kind}`);
    },
  },
});

console.log(JSON.stringify({ module: MODULE_ID, version: VERSION, port: server.port, mp: '1.0' }));
