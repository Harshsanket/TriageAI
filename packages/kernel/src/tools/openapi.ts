/** Generic OpenAPI importer (Phase 15.T7): read operations become enabled tool
 * descriptors; writes start disabled until an admin completes the contract. */
import type { ToolAccess, ToolRisk, ToolUndo } from './types.js';

export interface OpenApiOperation {
  method: string;
  path: string;
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: Array<{ name: string; in: string; required?: boolean }>;
  requestBody?: unknown;
}

export interface ImportedConnectorTool {
  name: string;
  description: string;
  access: ToolAccess;
  risk: ToolRisk;
  undo: ToolUndo;
  enabled: boolean;
  idempotent: boolean;
  inputSchema: Record<string, unknown>;
  operation: OpenApiOperation;
}

const WRITE_METHODS = new Set(['post', 'put', 'patch', 'delete']);

function operationName(method: string, path: string, operationId?: string): string {
  if (operationId) {
    return `openapi.${operationId}`
      .toLowerCase()
      .replace(/[^a-z0-9_.]/g, '_')
      .slice(0, 64);
  }
  const verb =
    method.toLowerCase() === 'get'
      ? 'get'
      : method.toLowerCase() === 'delete'
        ? 'delete'
        : method.toLowerCase() === 'post'
          ? 'create'
          : 'update';
  const object = path
    .split('/')
    .filter((part) => part && !part.startsWith('{'))
    .at(-1);
  return `openapi.${verb}_${(object ?? 'resource').toLowerCase().replace(/[^a-z0-9_]/g, '_')}`.slice(
    0,
    64,
  );
}

type RawOperation = Omit<OpenApiOperation, 'method' | 'path'>;

export function importOpenApi(spec: {
  paths?: Record<string, Record<string, RawOperation>>;
}): ImportedConnectorTool[] {
  const tools: ImportedConnectorTool[] = [];
  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(methods)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      const write = WRITE_METHODS.has(method);
      tools.push({
        name: operationName(method, path, operation.operationId),
        description: (
          operation.summary ??
          operation.description ??
          `${method.toUpperCase()} ${path}`
        ).slice(0, 400),
        access: write ? 'write' : 'read',
        risk: write ? 'high' : 'low',
        undo: write ? 'none' : 'free',
        enabled: !write,
        idempotent: !write,
        inputSchema: {
          type: 'object',
          properties: Object.fromEntries(
            (operation.parameters ?? []).map((parameter) => [
              parameter.name,
              { type: 'string', in: parameter.in },
            ]),
          ),
        },
        operation: { ...operation, method, path },
      });
    }
  }
  return tools;
}
