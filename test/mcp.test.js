import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpManager } from '../src/core/mcp.js';
import { ToolRegistry } from '../src/tools/registry.js';

async function makeWorkspace() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'nexuscode-mcp-'));
  await fs.mkdir(path.join(workspace, '.agent'), { recursive: true });
  return workspace;
}

test('MCP manager wires stdio, Streamable HTTP, and SSE transports', async (t) => {
  const workspace = await makeWorkspace();
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));

  await fs.writeFile(path.join(workspace, '.agent', 'mcp.json'), JSON.stringify({
    servers: [
      { name: 'local files', command: process.execPath, args: ['--version'] },
      { name: 'remote-http', url: 'http://127.0.0.1:43123/mcp', transport: 'streamable-http' },
      { name: 'legacy-sse', url: 'http://127.0.0.1:43124/sse', transport: 'sse' }
    ]
  }, null, 2));

  const connections = new Map();
  const clients = new Map();
  const manager = new McpManager(workspace, {
    clientFactory(name) {
      const client = {
        async connect(transport) {
          connections.set(name, transport);
        },
        async listTools() {
          return {
            tools: [{
              name: 'echo',
              description: 'Echo the supplied message',
              inputSchema: {
                type: 'object',
                properties: { message: { type: 'string' } },
                required: ['message']
              }
            }]
          };
        },
        async callTool({ name: toolName, arguments: args }) {
          assert.equal(toolName, 'echo');
          return { content: [{ type: 'text', text: `pong:${args.message}` }] };
        },
        async close() {
          clients.set(name, 'closed');
        }
      };
      return client;
    }
  });
  const registry = new ToolRegistry();

  const results = await manager.connectAll(registry);
  assert.equal(results.length, 3);
  assert.ok(results.every(result => result.ok));
  assert.ok(connections.get('local_files') instanceof StdioClientTransport);
  assert.ok(connections.get('remote_http') instanceof StreamableHTTPClientTransport);
  assert.ok(connections.get('legacy_sse') instanceof SSEClientTransport);

  for (const name of ['local_files', 'remote_http', 'legacy_sse']) {
    const toolName = `${name}__echo`;
    assert.equal(registry.has(toolName), true);
    assert.equal(registry.get(toolName).source, 'mcp');
    assert.equal(await registry.execute(toolName, { message: name }), `pong:${name}`);
  }

  await manager.disconnectAll();
  assert.equal(clients.size, 3);
  assert.ok(['local_files', 'remote_http', 'legacy_sse'].every(name => clients.get(name) === 'closed'));
  assert.equal(registry.has('local_files__echo'), false);
  assert.equal(registry.has('remote_http__echo'), false);
  assert.equal(registry.has('legacy_sse__echo'), false);
});

test('MCP config rejects unsupported transports and invalid URL protocols', async (t) => {
  const workspace = await makeWorkspace();
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));

  await fs.writeFile(path.join(workspace, '.agent', 'mcp.json'), JSON.stringify({
    servers: [
      { name: 'unsupported', url: 'https://example.com/mcp', transport: 'websocket' },
      { name: 'unsafe-scheme', url: 'file:///tmp/mcp.sock', transport: 'streamable-http' }
    ]
  }));

  let closed = 0;
  const manager = new McpManager(workspace, {
    clientFactory() {
      return {
        async connect() { throw new Error('connect should not be called'); },
        async close() { closed += 1; }
      };
    }
  });
  const results = await manager.connectAll(new ToolRegistry());

  assert.equal(results.length, 2);
  assert.ok(results.every(result => result.ok === false));
  assert.match(results[0].error, /Unsupported MCP transport/);
  assert.match(results[1].error, /HTTP or HTTPS/);
  assert.equal(closed, 2);
});
