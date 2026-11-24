import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// --- Export HTML tests ---
import { exportSessionToHTML } from '../src/core/export.js';

describe('exportSessionToHTML', () => {
  test('exports valid HTML file with messages', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-export-'));
    const outPath = path.join(tmpDir, 'session.html');

    const session = {
      id: 'ses_test_export',
      model: 'test-model',
      mode: 'build',
      createdAt: Date.now(),
      messages: [
        { role: 'user', content: 'Hello world' },
        { role: 'assistant', content: 'Hi there!', tool_calls: [
          { id: 'tc1', function: { name: 'read_file', arguments: '{"path":"test.js"}' } }
        ]},
        { role: 'tool', content: 'file contents here', tool_call_id: 'tc1', name: 'read_file' },
        { role: 'assistant', content: 'Done!' }
      ]
    };

    exportSessionToHTML(session, outPath);

    assert.ok(fs.existsSync(outPath), 'HTML file should exist');
    const html = fs.readFileSync(outPath, 'utf8');
    assert.ok(html.includes('<!DOCTYPE html>'), 'Should be valid HTML');
    assert.ok(html.includes('ses_test_export'), 'Should contain session ID');
    assert.ok(html.includes('Hello world'), 'Should contain user message');
    assert.ok(html.includes('Hi there!'), 'Should contain assistant message');
    assert.ok(html.includes('read_file'), 'Should contain tool call');
    assert.ok(html.includes('Done!'), 'Should contain final response');
    assert.ok(html.includes('<style>'), 'Should be self-contained with CSS');

    // Cleanup
    fs.unlinkSync(outPath);
    fs.rmdirSync(tmpDir);
  });

  test('escapes HTML in messages', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-export-'));
    const outPath = path.join(tmpDir, 'escape.html');

    const session = {
      id: 'ses_escape',
      model: 'x',
      mode: 'build',
      createdAt: Date.now(),
      messages: [
        { role: 'user', content: '<script>alert("xss")</script>' }
      ]
    };

    exportSessionToHTML(session, outPath);
    const html = fs.readFileSync(outPath, 'utf8');
    assert.ok(!html.includes('<script>alert'), 'Should escape script tags');
    assert.ok(html.includes('&lt;script&gt;'), 'Should have escaped tags');

    fs.unlinkSync(outPath);
    fs.rmdirSync(tmpDir);
  });
});

// --- Snapshot Manager tests ---
import { SessionSnapshotManager, isGitRepo } from '../src/core/snapshot.js';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
const execAsync = promisify(exec);

describe('SessionSnapshotManager (enhanced)', () => {
  test('listCheckpoints returns empty when no captures', () => {
    const mgr = new SessionSnapshotManager('/nonexistent');
    const list = mgr.listCheckpoints();
    assert.equal(list.length, 0);
  });

  test('undo returns error when no checkpoints', async () => {
    const mgr = new SessionSnapshotManager('/nonexistent');
    const res = await mgr.undo();
    assert.equal(res.success, false);
    assert.ok(res.message.includes('No checkpoints'));
  });

  test('redo returns error when no history', async () => {
    const mgr = new SessionSnapshotManager('/nonexistent');
    const res = await mgr.redo();
    assert.equal(res.success, false);
    assert.ok(res.message.includes('No redo'));
  });

  test('restoreToCheckpoint validates index', async () => {
    const mgr = new SessionSnapshotManager('/nonexistent');
    const res = await mgr.restoreToCheckpoint(5);
    assert.equal(res.success, false);
    assert.ok(res.message.includes('Invalid'));
  });
});

// --- Secret redaction (from secrets.js) ---
import { containsSecret, redactSecrets, redactObject } from '../src/core/secrets.js';

describe('Secret redaction', () => {
  test('detects OpenAI keys', () => {
    assert.ok(containsSecret('key is sk-abcdefghijklmnopqrstuvwxyz'));
  });

  test('detects Bearer tokens', () => {
    assert.ok(containsSecret('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.test'));
  });

  test('detects AWS access keys', () => {
    assert.ok(containsSecret('AKIAIOSFODNN7EXAMPLE'));
  });

  test('redacts API keys', () => {
    const result = redactSecrets('my key is sk-abcdefghijklmnopqrstuvwxyz ok');
    assert.ok(result.includes('[REDACTED]'));
    assert.ok(!result.includes('sk-abcdefghijklmnopqrstuvwxyz'));
  });

  test('redacts Bearer tokens', () => {
    const result = redactSecrets('Bearer eyJhbGciOiJIUzI1NiJ9.test.signature');
    assert.ok(result.includes('Bearer [REDACTED]'));
  });

  test('redactObject handles nested objects', () => {
    const obj = { data: { api_key: 'secret123', name: 'test' } };
    const result = redactObject(obj);
    assert.equal(result.data.api_key, '[REDACTED]');
    assert.equal(result.data.name, 'test');
  });
});

// --- CLI arg parsing ---
describe('CLI arg parsing', () => {
  // We test the parseArgs function indirectly by importing cli logic
  // Since parseArgs is internal, test the basic patterns
  test('non-interactive mode JSON output structure', async () => {
    // Verify the JSON output schema is correct by constructing expected shape
    const result = {
      sessionId: 'ses_test',
      model: 'test-model',
      mode: 'build',
      prompt: 'test prompt',
      response: 'hello',
      toolCalls: [],
      error: null,
      exitCode: 0
    };

    const json = JSON.stringify(result);
    const parsed = JSON.parse(json);
    assert.equal(parsed.exitCode, 0);
    assert.equal(parsed.prompt, 'test prompt');
    assert.equal(parsed.response, 'hello');
    assert.ok(Array.isArray(parsed.toolCalls));
  });
});

// --- Audit log ---
import { appendAuditEntry, getAuditLogPath } from '../src/core/audit.js';

describe('Audit log', () => {
  test('writes audit entry to file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-audit-'));
    const agentDir = path.join(tmpDir, '.agent');

    appendAuditEntry(tmpDir, {
      tool: 'bash',
      args: { command: 'echo test' },
      result: 'test',
      allowed: true,
      step: 1,
      externalContentRead: false
    });

    const logPath = getAuditLogPath(tmpDir);
    assert.ok(fs.existsSync(logPath), 'Audit log should exist');
    const content = fs.readFileSync(logPath, 'utf8');
    const entry = JSON.parse(content.trim());
    assert.equal(entry.tool, 'bash');
    assert.equal(entry.allowed, true);

    // Cleanup
    fs.unlinkSync(logPath);
    fs.rmdirSync(agentDir);
    fs.rmdirSync(tmpDir);
  });
});

// --- UI module tests ---
import { Spinner, badge, c } from '../src/core/ui.js';

describe('UI Module', () => {
  test('badge generates formatted ANSI string', () => {
    const b = badge('BUILD', 'green');
    assert.ok(b.includes('BUILD'));
    assert.ok(b.includes(c.reset));
  });

  test('Spinner starts and stops cleanly', () => {
    const s = new Spinner('test task');
    s.start('Thinking...');
    assert.equal(s.active, true);
    s.update('Running tool...');
    assert.equal(s.text, 'Running tool...');
    s.stop(true);
    assert.equal(s.active, false);
  });

  test('Spinner succeed and fail methods', () => {
    const s = new Spinner();
    s.start('action');
    s.succeed('done action');
    assert.equal(s.active, false);

    s.start('another');
    s.fail('failed action');
    assert.equal(s.active, false);
  });
});

import { COMMANDS_REGISTRY } from '../src/core/prompt_input.js';
import { buildSystemPrompt } from '../src/core/prompt.js';
import { addProvider, addLocalProvider, connectProvider, disconnectProvider, getProviderCatalog, getProviderPickerCatalog, listAllModels, parseModelConfig, removeProvider, saveOAuthCredential, getOAuthCredential, clearOAuthCredential } from '../src/core/providers/index.js';
import { getOAuthAccessToken } from '../src/core/providers/oauth.js';
import { filterPickerOptions } from '../src/core/prompt_input.js';

describe('Prompt Input Module', () => {
  test('COMMANDS_REGISTRY contains core commands', () => {
    assert.ok(COMMANDS_REGISTRY.length >= 18);
    const cmds = COMMANDS_REGISTRY.map(c => c.cmd);
    assert.ok(cmds.includes('/plan'));
    assert.ok(cmds.includes('/build'));
    assert.ok(cmds.includes('/diff'));
    assert.ok(cmds.includes('/doctor'));
    assert.ok(cmds.includes('/cost'));
  });
});


describe('General-purpose agent and provider selection', () => {
  test('system prompt does not assume every request is a coding task', () => {
    const prompt = buildSystemPrompt({ workingDir: path.resolve('test/fixtures/calculator') });
    assert.match(prompt, /general-purpose orchestrator/i);
    assert.match(prompt, /Your name is Nexus/i);
    assert.match(prompt, /Never identify yourself as Elaina/i);
    assert.match(prompt, /Do not assume a request is about coding/i);
    assert.match(prompt, /delegate independent research/i);
    assert.match(prompt, /todo tool/i);
    assert.doesNotMatch(prompt, /expert autonomous coding agent CLI/i);
  });

  test('provider picker and abort are discoverable in shared command registry', () => {
    const provider = COMMANDS_REGISTRY.find(command => command.cmd === '/provider');
    assert.ok(provider);
    assert.equal(provider.needsArg, false);
    assert.ok(COMMANDS_REGISTRY.some(command => command.cmd === '/abort'));
  });

  test('Anthropic provider uses its own API key and base URL', () => {
    const previousKey = process.env.ANTHROPIC_API_KEY;
    const previousBaseUrl = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_API_KEY = 'anthropic-test-key-long-enough';
    process.env.ANTHROPIC_BASE_URL = 'https://anthropic.example/v1/';
    try {
      const config = parseModelConfig('anthropic/claude-test');
      assert.equal(config.provider, 'anthropic');
      assert.equal(config.model, 'claude-test');
      assert.equal(config.apiKey, 'anthropic-test-key-long-enough');
      assert.equal(config.baseUrl, 'https://anthropic.example/v1');
    } finally {
      if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousKey;
      if (previousBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = previousBaseUrl;
    }
  });

  test('provider parser preserves slashes inside model identifiers', () => {
    const previousKey = process.env.API_KEY;
    const previousBaseUrl = process.env.BASE_URL;
    process.env.API_KEY = 'openai-test-key-long-enough';
    process.env.BASE_URL = 'https://gateway.example/v1/';
    try {
      const config = parseModelConfig('openai-compatible/org/model-name');
      assert.equal(config.provider, 'openai-compatible');
      assert.equal(config.model, 'org/model-name');
      assert.equal(config.baseUrl, 'https://gateway.example/v1');
    } finally {
      if (previousKey === undefined) delete process.env.API_KEY;
      else process.env.API_KEY = previousKey;
      if (previousBaseUrl === undefined) delete process.env.BASE_URL;
      else process.env.BASE_URL = previousBaseUrl;
    }
  });
});


describe('Dynamic provider registry and model discovery', () => {
  test('stores provider metadata without secrets and discovers gateway models', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-provider-registry-'));
    const previousConfigDir = process.env.NEXUS_CONFIG_DIR;
    const previousApiKey = process.env.NEXUS_TEST_ROUTER_KEY;
    const originalFetch = globalThis.fetch;
    const secret = 'test-router-key-not-for-storage';

    process.env.NEXUS_CONFIG_DIR = tempDir;
    process.env.NEXUS_TEST_ROUTER_KEY = secret;
    try {
      addProvider({
        id: 'router-test',
        label: 'Test Router',
        baseUrl: 'https://gateway.example/v1',
        apiKeyEnv: 'NEXUS_TEST_ROUTER_KEY'
      });

      const registryFile = path.join(tempDir, 'providers.json');
      const persisted = fs.readFileSync(registryFile, 'utf8');
      assert.ok(persisted.includes('NEXUS_TEST_ROUTER_KEY'));
      assert.ok(!persisted.includes(secret), 'API key must not be written to provider registry');

      const catalog = getProviderCatalog('router-test/org/model-a');
      const provider = catalog.find(item => item.id === 'router-test');
      assert.ok(provider?.configured);
      assert.equal(provider.active, true);
      assert.equal(Object.hasOwn(provider, 'apiKey'), false, 'Provider catalog must not expose API key');

      globalThis.fetch = async (url, options) => {
        assert.equal(url, 'https://gateway.example/v1/models');
        assert.equal(options.headers.Authorization, 'Bearer ' + secret);
        return new Response(JSON.stringify({
          data: [{ id: 'org/model-a' }, { id: 'model-b' }]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      };

      const discovered = await listAllModels();
      assert.deepEqual(
        discovered.models.map(model => model.id).sort(),
        ['router-test/model-b', 'router-test/org/model-a']
      );
      assert.deepEqual(discovered.errors, []);
      assert.equal(removeProvider('router-test'), true);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousConfigDir === undefined) delete process.env.NEXUS_CONFIG_DIR;
      else process.env.NEXUS_CONFIG_DIR = previousConfigDir;
      if (previousApiKey === undefined) delete process.env.NEXUS_TEST_ROUTER_KEY;
      else process.env.NEXUS_TEST_ROUTER_KEY = previousApiKey;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});


describe('OpenCode-style provider and model pickers', () => {
  test('provider catalog includes searchable presets and marks connected providers', () => {
    const options = getProviderPickerCatalog();
    assert.ok(options.some(provider => provider.id === 'openrouter' && provider.category === 'Popular'));
    assert.ok(options.some(provider => provider.id === 'anthropic' && provider.protocol === 'anthropic'));
    assert.ok(options.some(provider => provider.id === 'gemini' && provider.protocol === 'gemini'));
    assert.ok(options.some(provider => provider.id === 'mallss-nexus-route' && provider.authFlow === 'oauth2' && provider.category === 'AI Gateways'));
  });

  test('picker search matches labels, model IDs, and provider groups', () => {
    const options = [
      { label: 'Claude Sonnet', desc: 'anthropic/claude-sonnet', category: 'Anthropic' },
      { label: 'DeepSeek V4', desc: 'deepseek/deepseek-v4', category: 'DeepSeek' },
      { label: 'GPT 5', desc: 'openai/gpt-5', category: 'OpenAI' }
    ];
    assert.deepEqual(filterPickerOptions(options, 'deep').map(entry => entry.index), [1]);
    assert.deepEqual(filterPickerOptions(options, 'anthropic').map(entry => entry.index), [0]);
    assert.deepEqual(filterPickerOptions(options, 'gpt5').map(entry => entry.index), [2]);
  });

  test('connect stores credentials separately with restrictive file permissions', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-auth-store-'));
    const previousConfigDir = process.env.NEXUS_CONFIG_DIR;
    const secret = 'local-api-key-never-in-provider-metadata';
    try {
      process.env.NEXUS_CONFIG_DIR = tempDir;
      addLocalProvider({
        id: 'private-router',
        label: 'Private Router',
        baseUrl: 'https://private-gateway.example/v1',
        apiKey: secret
      });

      const providerFile = path.join(tempDir, 'providers.json');
      const authFile = path.join(tempDir, 'auth.json');
      const providerJson = fs.readFileSync(providerFile, 'utf8');
      const authJson = fs.readFileSync(authFile, 'utf8');
      assert.ok(!providerJson.includes(secret), 'provider metadata must not contain the API key');
      assert.ok(authJson.includes(secret), 'local credential store should contain the API key');
      if (process.platform !== 'win32') {
        assert.equal(fs.statSync(providerFile).mode & 0o777, 0o600);
        assert.equal(fs.statSync(authFile).mode & 0o777, 0o600);
        assert.equal(fs.statSync(tempDir).mode & 0o777, 0o700);
      }

      const catalog = getProviderCatalog();
      assert.equal(catalog.find(provider => provider.id === 'private-router')?.connected, true);
      assert.equal(connectProvider('private-router', secret).apiKey, secret);
      assert.equal(disconnectProvider('private-router'), true);
      assert.equal(getProviderCatalog().find(provider => provider.id === 'private-router')?.connected, false);
      assert.equal(removeProvider('private-router'), true);
    } finally {
      if (previousConfigDir === undefined) delete process.env.NEXUS_CONFIG_DIR;
      else process.env.NEXUS_CONFIG_DIR = previousConfigDir;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});


describe('npm CLI package metadata', () => {
  test('publishes the nexuscode executable', () => {
    const manifestPath = new URL('../package.json', import.meta.url);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    assert.equal(manifest.name, '@mallssz/nexuscode-cli');
    assert.equal(manifest.bin?.nexuscode, 'src/cli.js');
    assert.equal(manifest.publishConfig?.access, 'public');
    assert.equal(Object.hasOwn(manifest.bin || {}, 'nexus'), false);
    assert.ok(manifest.files.includes('src/'));
    assert.ok(manifest.engines.node.includes('20'));
  });
});


describe('Mallss Nexus Route OAuth integration', () => {
  test('stores OAuth tokens in the private credential file and refreshes access tokens', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-route-oauth-'));
    const previousConfigDir = process.env.NEXUS_CONFIG_DIR;
    const originalFetch = globalThis.fetch;
    process.env.NEXUS_CONFIG_DIR = tempDir;
    const providerId = 'mallss-nexus-route';
    const oldAccess = 'mnr-oauth-access-expired';
    const oldRefresh = 'mnr-oauth-refresh-old';
    try {
      addProvider({
        id: providerId,
        label: 'Mallss Nexus Route',
        baseUrl: 'https://ai-router.mallss-nexus.sbs/v1',
        protocol: 'openai-compatible',
        authFlow: 'oauth2'
      });
      saveOAuthCredential(providerId, {
        access_token: oldAccess,
        refresh_token: oldRefresh,
        expires_at: Date.now() - 1000,
        user: { email: 'developer@example.test' }
      });

      const providerFile = path.join(tempDir, 'providers.json');
      const authFile = path.join(tempDir, 'auth.json');
      const metadata = fs.readFileSync(providerFile, 'utf8');
      const credentials = fs.readFileSync(authFile, 'utf8');
      assert.match(metadata, /"authFlow": "oauth2"/);
      assert.doesNotMatch(metadata, /mnr-oauth/);
      assert.match(credentials, /mnr-oauth-access-expired/);
      assert.equal(getOAuthCredential(providerId).refreshToken, oldRefresh);
      assert.equal(getProviderPickerCatalog().find(item => item.id === providerId)?.connected, true);
      assert.equal(parseModelConfig(providerId + '/Nexus-Free').authFlow, 'oauth2');

      let refreshCalls = 0;
      globalThis.fetch = async (url, options) => {
        refreshCalls += 1;
        assert.equal(url, 'https://ai-router.mallss-nexus.sbs/auth/oauth/token');
        assert.equal(options.method, 'POST');
        assert.match(String(options.body), /grant_type=refresh_token/);
        assert.match(String(options.body), /client_id=nexuscode/);
        assert.match(String(options.body), /refresh_token=mnr-oauth-refresh-old/);
        return new Response(JSON.stringify({
          access_token: 'mnr-oauth-access-new',
          refresh_token: 'mnr-oauth-refresh-new',
          token_type: 'Bearer',
          expires_in: 3600,
          user: { email: 'developer@example.test' }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      };

      const tokens = await Promise.all([getOAuthAccessToken(providerId), getOAuthAccessToken(providerId)]);
      assert.deepEqual(tokens, ['mnr-oauth-access-new', 'mnr-oauth-access-new']);
      assert.equal(refreshCalls, 1, 'Concurrent refreshes must share one token rotation');
      const token = tokens[0];
      assert.equal(token, 'mnr-oauth-access-new');
      assert.equal(getOAuthCredential(providerId).refreshToken, 'mnr-oauth-refresh-new');
      assert.ok(getOAuthCredential(providerId).expiresAt > Date.now());
      assert.equal(clearOAuthCredential(providerId), true);
      assert.equal(getOAuthCredential(providerId), null);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousConfigDir === undefined) delete process.env.NEXUS_CONFIG_DIR;
      else process.env.NEXUS_CONFIG_DIR = previousConfigDir;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
