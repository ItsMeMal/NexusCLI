import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExtensionManager } from '../src/core/extensions.js';
import { runAgentLoop } from '../src/core/loop.js';
import { PermissionManager } from '../src/core/permission.js';
import { createDefaultRegistry } from '../src/tools/index.js';
import { createNexusServer } from '../src/server.js';

async function makeWorkspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nexuscode-extensions-'));
}

test('plugin tools and lifecycle hooks run inside the agent loop', async (t) => {
  const workspace = await makeWorkspace();
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));

  const pluginsDir = path.join(workspace, '.agent', 'plugins');
  await fs.mkdir(pluginsDir, { recursive: true });
  await fs.writeFile(path.join(pluginsDir, 'sample.mjs'), `
    export default ({ registerTool, hooks, registry }) => {
      if (typeof registry.register !== 'undefined') {
        throw new Error('Plugin registry must be read-only.');
      }
      registerTool({
        name: 'plugin_greet',
        source: 'builtin',
        description: 'Create a greeting',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name']
        },
        async execute({ name }) {
          return 'hello ' + name;
        }
      });

      hooks.on_message.push(({ message }) => {
        message.content = message.content.toUpperCase();
      });
      hooks.before_tool.push(({ args }) => {
        args.name += '-before';
      });
      hooks.after_tool.push((event) => {
        event.output += '-after';
      });
    };
  `);

  const registry = createDefaultRegistry();
  const extensions = new ExtensionManager(workspace);
  const status = await extensions.initialize(registry);

  assert.deepEqual(status.plugins, [{ file: 'sample.mjs', ok: true }]);
  assert.equal(registry.has('plugin_greet'), true);
  assert.equal(registry.get('plugin_greet').source, 'plugin');

  let modelCalls = 0;
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: 'hello nexus' }],
    registry,
    maxSteps: 3,
    chatFn: async (messages, definitions) => {
      modelCalls += 1;
      if (modelCalls === 1) {
        assert.equal(messages.at(-1).content, 'HELLO NEXUS');
        assert.ok(definitions.some(item => item.function.name === 'plugin_greet'));
        return {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'plugin-call-1',
            type: 'function',
            function: {
              name: 'plugin_greet',
              arguments: JSON.stringify({ name: 'Nexus' })
            }
          }]
        };
      }

      const toolMessage = messages.find(message => message.role === 'tool' && message.name === 'plugin_greet');
      assert.ok(toolMessage);
      assert.match(toolMessage.content, /UNTRUSTED_EXTERNAL_DATA/);
      assert.match(toolMessage.content, /hello Nexus-before-after/);
      assert.match(toolMessage.content, /END_UNTRUSTED_EXTERNAL_DATA/);
      return { role: 'assistant', content: 'plugin workflow complete' };
    },
    ctx: {
      cwd: workspace,
      mode: 'build',
      autoApprove: true,
      pluginManager: extensions.plugins
    }
  });

  assert.equal(result.completed, true);
  assert.equal(result.finalMessage.content, 'plugin workflow complete');
  assert.equal(modelCalls, 2);
  await extensions.shutdown();
});

test('plugin and MCP tools follow a conservative permission policy', async () => {
  const registry = createDefaultRegistry();
  registry.register({
    name: 'custom_plugin_tool',
    source: 'plugin',
    description: 'test',
    parameters: { type: 'object', properties: {} },
    async execute() { return 'ok'; }
  });
  registry.register({
    name: 'filesystem__write',
    source: 'mcp',
    description: 'test',
    parameters: { type: 'object', properties: {} },
    async execute() { return 'ok'; }
  });

  const permissions = new PermissionManager();
  assert.equal(permissions.evaluate('custom_plugin_tool', {}, { registry, mode: 'build' }).action, 'ask');
  assert.equal(permissions.evaluate('filesystem__write', {}, { registry, mode: 'build' }).action, 'ask');
  assert.equal(permissions.evaluate('custom_plugin_tool', {}, { registry, mode: 'plan' }).action, 'deny');
  assert.equal(permissions.evaluate('filesystem__write', {}, { registry, mode: 'plan' }).action, 'deny');
});

test('server initializes workspace plugins before accepting sessions', async (t) => {
  const workspace = await makeWorkspace();
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));

  const pluginsDir = path.join(workspace, '.agent', 'plugins');
  await fs.mkdir(pluginsDir, { recursive: true });
  await fs.writeFile(path.join(pluginsDir, 'server-plugin.mjs'), `
    export default ({ registerTool }) => {
      registerTool({
        name: 'server_plugin_ping',
        description: 'Ping from a workspace extension',
        parameters: { type: 'object', properties: {} },
        async execute() { return 'pong'; }
      });
    };
  `);

  const nexus = createNexusServer({ workingDir: workspace, host: '127.0.0.1', port: 0 });
  const info = await nexus.start();
  try {
    assert.deepEqual(info.extensions.plugins, [{ file: 'server-plugin.mjs', ok: true }]);
    assert.equal(nexus.registry.has('server_plugin_ping'), true);
    assert.equal(nexus.registry.get('server_plugin_ping').source, 'plugin');
  } finally {
    await nexus.close();
  }
});
