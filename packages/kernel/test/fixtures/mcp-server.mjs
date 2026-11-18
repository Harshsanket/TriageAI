#!/usr/bin/env node
/**
 * Minimal MCP stdio fixture: newline-delimited JSON-RPC on stdin/stdout,
 * stderr logs only. No network and no dependencies.
 */
import process from 'node:process';

process.stderr.write('mcp fixture ready\n');

const tools = [
  { name: 'get_deal', description: 'Read a deal from the fixture CRM.' },
  { name: 'create_deal', description: 'Create a deal in the fixture CRM.' },
  { name: 'run_generation', description: 'Generate a summary with a fixture model.' },
  { name: 'env_value', description: 'Return the FIXTURE_VALUE environment variable.' },
  { name: 'slow_tool', description: 'Never answers; used to test request timeouts.' },
  { name: 'crash_tool', description: 'Exits the fixture process.' },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture', version: '1.0.0' },
      },
    });
    return;
  }
  if (message.method === 'notifications/initialized') return;
  if (message.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { tools: tools.map((tool) => ({ ...tool, inputSchema: { type: 'object' } })) },
    });
    return;
  }
  if (message.method === 'tools/call') {
    const name = message.params?.name;
    if (name === 'slow_tool') return;
    if (name === 'crash_tool') process.exit(3);
    const text = name === 'env_value' ? (process.env.FIXTURE_VALUE ?? '') : `ok:${String(name)}`;
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text }], isError: false },
    });
    return;
  }
  if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } });
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf('\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handle(line);
  }
});
process.stdin.on('end', () => process.exit(0));
