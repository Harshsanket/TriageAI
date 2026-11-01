import { describe, expect, it } from 'vitest';

import { importOpenApi } from '../src/tools/openapi.js';

describe('OpenAPI connector import (phase 15)', () => {
  it('enables reads and leaves writes disabled until completed', () => {
    const tools = importOpenApi({
      paths: {
        '/deals/{id}': {
          get: {
            operationId: 'getDeal',
            summary: 'Get a CRM deal by id',
            parameters: [{ name: 'id', in: 'path', required: true }],
          },
        },
        '/deals': {
          post: { operationId: 'createDeal', summary: 'Create a CRM deal' },
        },
      },
    });
    const read = tools.find((tool) => tool.operation.method === 'get');
    const write = tools.find((tool) => tool.operation.method === 'post');
    expect(read).toMatchObject({ access: 'read', risk: 'low', enabled: true, undo: 'free' });
    expect(write).toMatchObject({ access: 'write', risk: 'high', enabled: false, undo: 'none' });
    expect(read?.inputSchema).toMatchObject({ properties: { id: { type: 'string' } } });
  });
});
