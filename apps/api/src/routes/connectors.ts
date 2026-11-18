/**
 * 15.T7 connector administration: connections, import, contract completion and
 * connectivity tests. Imported tools start disabled; completion validates every
 * contract before any tool is registered.
 */
import type { FastifyInstance } from 'fastify';

import { invalid } from '@triageai/kernel';
import type { Kernel } from '@triageai/kernel';

import type { SetupRuntime } from '../setup/boot.js';
import { runConnectorSync } from '../services/connectorSync.js';
import {
  addConnectorConnection,
  completeConnectorConnection,
  completeConnectorOAuth,
  ConnectorCompleteSchema,
  ConnectorConnectionInputSchema,
  ConnectorImportSchema,
  ConnectorUpdateSchema,
  importConnectorConnection,
  listConnectorConnections,
  removeConnectorConnection,
  setConnectorSecretReader,
  startConnectorOAuth,
  testConnectorConnection,
  updateConnectorConnection,
} from '../services/connectors.js';

export function registerConnectorRoutes(
  app: FastifyInstance,
  kernel: Kernel,
  runtime?: SetupRuntime,
): void {
  if (runtime) setConnectorSecretReader(runtime.secrets);

  app.get('/api/v1/connectors', async () => ({
    connections: await listConnectorConnections(kernel),
  }));

  app.post('/api/v1/connectors', async (request) => {
    const body = ConnectorConnectionInputSchema.parse(request.body ?? {});
    return addConnectorConnection(kernel, body, request.principal?.email ?? null);
  });

  app.put('/api/v1/connectors/:id', async (request) => {
    const { id } = request.params as { id: string };
    const body = ConnectorUpdateSchema.parse(request.body ?? {});
    return updateConnectorConnection(kernel, id, body, request.principal?.email ?? null);
  });

  app.delete('/api/v1/connectors/:id', async (request) => {
    const { id } = request.params as { id: string };
    return removeConnectorConnection(kernel, id, request.principal?.email ?? null);
  });

  app.post('/api/v1/connectors/:id/test', async (request) => {
    const { id } = request.params as { id: string };
    return testConnectorConnection(kernel, id);
  });

  app.post('/api/v1/connectors/:id/import', async (request) => {
    const { id } = request.params as { id: string };
    const body = ConnectorImportSchema.parse(request.body ?? {});
    return importConnectorConnection(kernel, id, body, request.principal?.email ?? null);
  });

  app.post('/api/v1/connectors/:id/oauth/start', async (request) => {
    const { id } = request.params as { id: string };
    return startConnectorOAuth(kernel, id, request.principal?.email ?? null);
  });

  // Provider redirect target: no session is present, so the one-time state is
  // the credential. Tokens are stored server-side and never returned.
  app.get('/api/v1/connectors/oauth/callback', async (request) => {
    const query = request.query as {
      code?: string;
      state?: string;
      nonce?: string;
      error?: string;
    };
    if (query.error) {
      throw invalid(`the provider rejected the authorization: ${query.error.slice(0, 100)}`);
    }
    if (!query.code || !query.state) throw invalid('code and state are required');
    return completeConnectorOAuth(
      kernel,
      {
        state: query.state,
        code: query.code,
        ...(query.nonce ? { nonce: query.nonce } : {}),
      },
      null,
    );
  });

  app.post('/api/v1/connectors/:id/sync', async (request) => {
    const { id } = request.params as { id: string };
    return runConnectorSync(kernel, id);
  });

  app.post('/api/v1/connectors/:id/complete', async (request) => {
    const { id } = request.params as { id: string };
    const body = ConnectorCompleteSchema.parse(request.body ?? {});
    return completeConnectorConnection(kernel, id, body, request.principal?.email ?? null);
  });
}
