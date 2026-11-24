import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';

const rootDir = process.argv[2] || process.cwd();

const server = new McpServer({
  name: 'filesystem',
  version: '1.0.0'
});

server.tool(
  'read_file',
  'Read a text file relative to root',
  { path: z.string().describe('Relative file path') },
  async ({ path: p }) => {
    const resolved = path.resolve(rootDir, p);
    if (!resolved.startsWith(path.resolve(rootDir))) {
      return { content: [{ type: 'text', text: 'Error: path outside root' }], isError: true };
    }
    try {
      const content = await fs.readFile(resolved, 'utf8');
      return { content: [{ type: 'text', text: content }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  'list_dir',
  'List entries in a directory relative to root',
  { path: z.string().optional().describe('Relative directory path (default ".")') },
  async ({ path: p = '.' }) => {
    const resolved = path.resolve(rootDir, p);
    if (!resolved.startsWith(path.resolve(rootDir))) {
      return { content: [{ type: 'text', text: 'Error: path outside root' }], isError: true };
    }
    try {
      const entries = await fs.readdir(resolved, { withFileTypes: true });
      const list = entries.map(e => (e.isDirectory() ? e.name + '/' : e.name)).join('\n');
      return { content: [{ type: 'text', text: list || '(empty)' }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);