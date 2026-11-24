import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

function sanitizeName(name) {
  return String(name || '').replace(/[^a-zA-Z0-9_]/g, '_');
}

export class McpManager {
  constructor(workingDir = process.cwd()) {
    this.workingDir = workingDir;
    this.clients = new Map(); // serverName -> { client, transport }
    this.registeredTools = []; // list of tool names
  }

  getConfigPath() {
    return path.join(this.workingDir, '.agent', 'mcp.json');
  }

  loadConfig() {
    const configPath = this.getConfigPath();
    if (!fs.existsSync(configPath)) return { servers: [] };
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(raw);
      return { servers: Array.isArray(parsed.servers) ? parsed.servers : [] };
    } catch (err) {
      console.warn(`[MCP] Failed to parse mcp.json: ${err.message}`);
      return { servers: [] };
    }
  }

  async connectServer(serverConfig, registry) {
    const name = sanitizeName(serverConfig.name || 'mcp');
    const client = new Client({ name: 'nexus-cli', version: '0.1.0' }, { capabilities: {} });

    let transport;
    if (serverConfig.url) {
      const url = new URL(serverConfig.url);
      if (serverConfig.transport === 'sse') {
        transport = new SSEClientTransport(url);
      } else {
        transport = new StreamableHTTPClientTransport(url);
      }
    } else if (serverConfig.command) {
      transport = new StdioClientTransport({
        command: serverConfig.command,
        args: Array.isArray(serverConfig.args) ? serverConfig.args : [],
        env: { ...process.env, ...(serverConfig.env || {}) },
        cwd: serverConfig.cwd || this.workingDir
      });
    } else {
      throw new Error(`MCP server "${name}" has no command or url.`);
    }

    await client.connect(transport);
    const { tools } = await client.listTools();

    const registered = [];
    for (const tool of tools || []) {
      const toolName = sanitizeName(tool.name);
      const prefixed = `${name}__${toolName}`;
      const mcpTool = {
        name: prefixed,
        description: `[MCP:${name}] ${tool.description || toolName}`,
        parameters: tool.inputSchema || { type: 'object', properties: {} },
        async execute(args = {}) {
          const result = await client.callTool({ name: tool.name, arguments: args });
          return formatToolResult(result);
        }
      };
      registry.register(mcpTool);
      registered.push(prefixed);
    }

    this.clients.set(name, { client, transport, serverConfig });
    this.registeredTools.push(...registered);
    return { name, toolCount: registered.length, tools: registered };
  }

  async connectAll(registry) {
    const config = this.loadConfig();
    const results = [];
    for (const server of config.servers) {
      try {
        const r = await this.connectServer(server, registry);
        results.push({ ...r, ok: true });
      } catch (err) {
        results.push({ name: server.name, ok: false, error: err.message });
        console.warn(`[MCP] Failed to connect "${server.name}": ${err.message}`);
      }
    }
    return results;
  }

  async disconnectAll() {
    for (const [name, { client }] of this.clients) {
      try { await client.close(); } catch { /* ignore */ }
    }
    this.clients.clear();
  }
}

function formatToolResult(result) {
  if (!result) return '';
  const content = Array.isArray(result.content) ? result.content : [];
  const parts = [];
  for (const item of content) {
    if (item.type === 'text') parts.push(item.text);
    else if (item.type === 'image') parts.push(`[image: ${item.mimeType || 'unknown'}]`);
    else if (item.type === 'resource') parts.push(JSON.stringify(item.resource || {}));
    else parts.push(JSON.stringify(item));
  }
  let text = parts.join('\n');
  if (result.isError) text = `Error: ${text}`;
  return text || (result.isError ? 'Error: (no details)' : '(no output)');
}

export default McpManager;