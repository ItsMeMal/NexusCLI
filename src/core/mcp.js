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
  constructor(workingDir = process.cwd(), options = {}) {
    this.workingDir = workingDir;
    this.clients = new Map();
    this.registeredTools = [];
    this.registry = null;
    this.clientFactory = options.clientFactory || (() =>
      new Client({ name: 'nexuscode', version: '0.1.2' }, { capabilities: {} }));
    this.transportFactory = options.transportFactory || ((serverConfig, name) => {
      if (serverConfig.url) {
        const url = new URL(serverConfig.url);
        if (!['http:', 'https:'].includes(url.protocol)) {
          throw new Error(`MCP server "${name}" URL must use HTTP or HTTPS.`);
        }
        if (serverConfig.transport === 'sse') return new SSEClientTransport(url);
        if (serverConfig.transport && serverConfig.transport !== 'streamable-http') {
          throw new Error(`Unsupported MCP transport "${serverConfig.transport}" for "${name}".`);
        }
        return new StreamableHTTPClientTransport(url);
      }
      if (serverConfig.command) {
        return new StdioClientTransport({
          command: serverConfig.command,
          args: Array.isArray(serverConfig.args) ? serverConfig.args : [],
          env: { ...process.env, ...(serverConfig.env || {}) },
          cwd: serverConfig.cwd || this.workingDir
        });
      }
      throw new Error(`MCP server "${name}" must define either "command" (stdio) or "url" (HTTP).`);
    });
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
      if (!Array.isArray(parsed.servers)) throw new Error('The "servers" field must be an array.');
      return { servers: parsed.servers };
    } catch (err) {
      console.warn(`[MCP] Failed to parse mcp.json: ${err.message}`);
      return { servers: [] };
    }
  }

  async connectServer(serverConfig, registry) {
    if (!serverConfig || typeof serverConfig !== 'object') {
      throw new Error('MCP server configuration must be an object.');
    }
    const name = sanitizeName(serverConfig.name) || 'mcp';
    if (this.clients.has(name)) {
      throw new Error(`MCP server name "${name}" is duplicated after normalization.`);
    }

    const client = this.clientFactory(name, serverConfig);
    let transport;
    const registered = [];
    try {
      transport = this.transportFactory(serverConfig, name);
      await client.connect(transport);
      const response = await client.listTools();
      const tools = Array.isArray(response?.tools) ? response.tools : [];

      for (const tool of tools) {
        if (!tool?.name) continue;
        const toolName = sanitizeName(tool.name);
        const prefixed = `${name}__${toolName}`;
        if (registry.has(prefixed)) throw new Error(`Tool "${prefixed}" is already registered.`);

        registry.register({
          name: prefixed,
          source: 'mcp',
          description: `[MCP:${name}] ${tool.description || toolName}`,
          parameters: tool.inputSchema || { type: 'object', properties: {} },
          async execute(args = {}) {
            const result = await client.callTool({ name: tool.name, arguments: args });
            return formatToolResult(result);
          }
        });
        registered.push(prefixed);
      }

      this.clients.set(name, { client, transport, serverConfig });
      this.registry = registry;
      this.registeredTools.push(...registered);
      return { name, toolCount: registered.length, tools: registered };
    } catch (err) {
      for (const toolName of registered) registry.unregister?.(toolName);
      try { await client.close(); } catch { /* best-effort cleanup after failed handshake */ }
      throw err;
    }
  }

  async connectAll(registry) {
    const config = this.loadConfig();
    const results = [];
    for (const server of config.servers) {
      try {
        const result = await this.connectServer(server, registry);
        results.push({ ...result, ok: true });
      } catch (err) {
        results.push({ name: server?.name || 'mcp', ok: false, error: err.message });
        console.warn(`[MCP] Failed to connect "${server?.name || 'mcp'}": ${err.message}`);
      }
    }
    return results;
  }

  async disconnectAll() {
    for (const [name, { client }] of this.clients) {
      try { await client.close(); } catch { /* best-effort shutdown */ }
      for (const toolName of this.registeredTools) {
        if (toolName.startsWith(`${name}__`)) this.registry?.unregister?.(toolName);
      }
    }
    this.clients.clear();
    this.registeredTools = [];
    this.registry = null;
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
