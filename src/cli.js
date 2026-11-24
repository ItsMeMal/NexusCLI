#!/usr/bin/env node

/**
 * NEXUSCODE CLI
 * Main entry point for interactive terminal and non-interactive CI execution.
 */

import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { createNexusServer } from './server.js';
import { SessionSnapshotManager, isGitRepo } from './core/snapshot.js';
import { exportSessionToHTML } from './core/export.js';
import { getModelConfig, estimateMessagesTokens } from './core/context.js';
import { isDockerAvailable } from './core/sandbox.js';
import { defaultRegistry } from './tools/index.js';
import {
  c,
  Spinner,
  badge,
  renderBanner,
  renderCommandList,
  renderDoctorReport,
  renderCostReport,
  renderSecurityPrompt
} from './core/ui.js';
import { promptWithAutocomplete, promptSelect, promptText, promptSecret, COMMANDS_REGISTRY } from './core/prompt_input.js';
import { addProvider, addLocalProvider, connectProvider, disconnectProvider, getDefaultModelSelection, getProviderCatalog, getProviderPickerCatalog, listAllModels, listProviderModels, removeProvider } from './core/providers/index.js';

function loadEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    try {
      const content = fs.readFileSync(envPath, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
          const key = trimmed.slice(0, eqIdx).trim();
          let val = trimmed.slice(eqIdx + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
      }
    } catch {
      // Ignore reading error
    }
  }
}

loadEnv();

// --- Argument Parsing ---

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {
    command: null,  // 'run' or null (interactive)
    prompt: null,
    json: false,
    debug: false,
    approve: false,
    model: null,
    mode: 'build'
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === 'run' && !parsed.command) {
      parsed.command = 'run';
      i++;
      if (i < args.length && !args[i].startsWith('--')) {
        parsed.prompt = args[i];
        i++;
      }
      continue;
    }
    if (arg === '--json') { parsed.json = true; i++; continue; }
    if (arg === '--debug') { parsed.debug = true; i++; continue; }
    if (arg === '--approve' || arg === '--yes' || arg === '-y') { parsed.approve = true; i++; continue; }
    if (arg === '--model' && i + 1 < args.length) { parsed.model = args[i + 1]; i += 2; continue; }
    if (arg === '--mode' && i + 1 < args.length) { parsed.mode = args[i + 1]; i += 2; continue; }
    if (!parsed.prompt && !arg.startsWith('--')) {
      parsed.prompt = arg;
    }
    i++;
  }
  return parsed;
}

// --- NexusClient ---

class NexusClient {
  constructor({ serverUrl, token }) {
    this.serverUrl = serverUrl.replace(/\/+$/, '');
    this.token = token;
    this.sessionId = null;
    this.sessionData = null;
  }

  getHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    return headers;
  }

  async createSession({ mode = 'build', model } = {}) {
    const res = await fetch(`${this.serverUrl}/session`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ mode, model })
    });
    if (!res.ok) {
      throw new Error(`Failed to create session: HTTP ${res.status}`);
    }
    const data = await res.json();
    this.sessionId = data.id;
    this.sessionData = data;
    return data;
  }

  async listSessions() {
    const res = await fetch(`${this.serverUrl}/session`, {
      headers: this.getHeaders()
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  }

  async loadSession(id) {
    const res = await fetch(`${this.serverUrl}/session/${id}`, {
      headers: this.getHeaders()
    });
    if (!res.ok) throw new Error(`Session ${id} not found: HTTP ${res.status}`);
    const data = await res.json();
    this.sessionId = data.id;
    this.sessionData = data;
    return data;
  }

  async updateSessionSettings(settings = {}) {
    const res = await fetch(`${this.serverUrl}/session/${this.sessionId}`, {
      method: 'PATCH',
      headers: this.getHeaders(),
      body: JSON.stringify(settings)
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    this.sessionData = { ...this.sessionData, ...data };
    return data;
  }

  async compactSession() {
    const res = await fetch(`${this.serverUrl}/session/${this.sessionId}/compact`, {
      method: 'POST',
      headers: this.getHeaders()
    });
    if (!res.ok) throw new Error(`Compaction failed: HTTP ${res.status}`);
    return await res.json();
  }

  async answerPermission(permId, allow) {
    const res = await fetch(`${this.serverUrl}/permission/${permId}`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ allow })
    });
    return res.ok;
  }

  async sendMessage(content, { onToken, onToolStart, onToolResult, onPermission, onDone, onError }) {
    const sseRes = await fetch(`${this.serverUrl}/session/${this.sessionId}/events`, {
      headers: this.getHeaders()
    });

    if (!sseRes.ok || !sseRes.body) {
      throw new Error(`Failed to connect to event stream: HTTP ${sseRes.status}`);
    }

    const reader = sseRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const streamPromise = new Promise(async (resolve, reject) => {
      let currentEvent = 'message';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(':')) continue;

            if (trimmed.startsWith('event: ')) {
              currentEvent = trimmed.slice(7).trim();
              continue;
            }

            if (trimmed.startsWith('data: ')) {
              const dataStr = trimmed.slice(6).trim();
              let parsedData = {};
              try {
                parsedData = JSON.parse(dataStr);
              } catch {
                parsedData = { raw: dataStr };
              }

              if (currentEvent === 'text.delta') {
                onToken?.(parsedData.text);
              } else if (currentEvent === 'tool.start') {
                onToolStart?.(parsedData);
              } else if (currentEvent === 'tool.result') {
                onToolResult?.(parsedData);
              } else if (currentEvent === 'permission.request') {
                onPermission?.(parsedData);
              } else if (currentEvent === 'done') {
                onDone?.(parsedData);
                try { await reader.cancel(); } catch {}
                resolve(parsedData);
                return;
              } else if (currentEvent === 'error') {
                onError?.(parsedData);
                try { await reader.cancel(); } catch {}
                reject(new Error(parsedData.message || 'Server loop error'));
                return;
              }
            }
          }
        }
        resolve();
      } catch (err) {
        reject(err);
      }
    });

    const postRes = await fetch(`${this.serverUrl}/session/${this.sessionId}/message`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ content })
    });

    if (!postRes.ok) {
      try { await reader.cancel(); } catch {}
      const errText = await postRes.text();
      throw new Error(`Failed to send message: HTTP ${postRes.status}: ${errText}`);
    }

    return await streamPromise;
  }
}

// --- Non-Interactive Run Mode (CI) ---

async function runNonInteractive(parsed) {
  let localServer = null;
  let serverUrl = process.env.NEXUS_SERVER_URL;
  const token = process.env.NEXUS_SERVER_TOKEN || null;

  if (!serverUrl) {
    localServer = createNexusServer({
      port: 0,
      host: '127.0.0.1',
      token,
      workingDir: process.cwd()
    });
    const info = await localServer.start();
    serverUrl = info.url;
  }

  const client = new NexusClient({ serverUrl, token });
  const model = parsed.model || getDefaultModelSelection() || process.env.MODEL || '';
  await client.createSession({ mode: parsed.mode, model });

  const result = {
    sessionId: client.sessionId,
    model,
    mode: parsed.mode,
    prompt: parsed.prompt,
    response: '',
    toolCalls: [],
    error: null,
    exitCode: 0
  };

  try {
    await client.sendMessage(parsed.prompt, {
      onToken: (tok) => {
        result.response += tok;
        if (!parsed.json) {
          process.stdout.write(tok);
        }
      },
      onToolStart: (event) => {
        result.toolCalls.push({ name: event.name, args: event.args, output: null });
        if (!parsed.json) {
          process.stderr.write(`\n⚙️ [call] ${event.name}\n`);
        }
      },
      onToolResult: (event) => {
        const last = result.toolCalls[result.toolCalls.length - 1];
        if (last) last.output = event.output;
      },
      onPermission: async (event) => {
        if (parsed.approve) {
          await client.answerPermission(event.id, true);
        } else {
          await client.answerPermission(event.id, false);
          if (!parsed.json) {
            process.stderr.write(`\n⚠️ Permission denied (non-interactive): ${event.tool}\n`);
          }
        }
      },
      onDone: (doneData) => {
        result.usage = doneData.usage || null;
      },
      onError: (errData) => {
        result.error = errData.message;
        result.exitCode = 1;
      }
    });
  } catch (err) {
    result.error = err.message;
    result.exitCode = 1;
  }

  if (localServer) {
    try { await localServer.close(); } catch {}
  }

  if (parsed.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else if (!result.response && !result.error) {
    // nothing to print
  } else {
    process.stdout.write('\n');
  }

  process.exit(result.exitCode);
}

// --- Interactive Mode with Real-Time Dropdown Palette ---

async function runInteractive(parsed) {
  let localServer = null;
  let serverUrl = process.env.NEXUS_SERVER_URL;
  const token = process.env.NEXUS_SERVER_TOKEN || null;
  const snapshotManager = new SessionSnapshotManager(process.cwd());
  const spinner = new Spinner();

  if (!serverUrl) {
    localServer = createNexusServer({
      port: 0,
      host: '127.0.0.1',
      token,
      workingDir: process.cwd()
    });
    const info = await localServer.start();
    serverUrl = info.url;
  }

  const client = new NexusClient({ serverUrl, token });
  const initialModel = parsed.model || getDefaultModelSelection() || process.env.MODEL || '';
  const initialMode = parsed.mode || 'build';

  await client.createSession({ mode: initialMode, model: initialModel });
  await snapshotManager.captureFirstSnapshot();

  const cleanup = async () => {
    spinner.stop(false);
    if (localServer) {
      try { await localServer.close(); } catch {}
    }
  };

  const executeTurn = async (userInput, autoApprove = false) => {
    let tokenStreamStarted = false;
    const turnStartTime = Date.now();
    spinner.start('( ✧ω✧) c( つ🪄✦ Menganalisis & merumuskan solusi...');

    await client.sendMessage(userInput, {
      onToken: (tok) => {
        if (!tokenStreamStarted) {
          spinner.stop(true);
          console.log(`\n  ${c.cyan}✦${c.reset} ${c.bold}${c.brightWhite}Nexus${c.reset} ${c.magenta}( ˘ᴗ˘ )🪄${c.reset} ${c.dim}›${c.reset}\n`);
          tokenStreamStarted = true;
        }
        process.stdout.write(tok);
      },
      onToolStart: (event) => {
        if (tokenStreamStarted) {
          process.stdout.write('\n');
          tokenStreamStarted = false;
        }
        const argsPreview = JSON.stringify(event.args || {});
        const shortArgs = argsPreview.length > 55 ? argsPreview.slice(0, 52) + '…' : argsPreview;
        spinner.start(`( •̀_•́ ) c( つ📦⚡ Tool: ${c.cyan}${c.bold}${event.name}${c.reset} ${c.dim}${shortArgs}${c.reset}`);
      },
      onToolResult: (event) => {
        const outStr = String(event.output || '');
        const snippet = outStr.length > 85
          ? outStr.slice(0, 85).replace(/\r?\n/g, ' ') + '…'
          : outStr.replace(/\r?\n/g, ' ');
        spinner.succeed(`( •̀ᴗ•́ ) c( つ📦✨ ${c.bold}${event.name}${c.reset} → ${c.dim}${snippet || '(success)'}${c.reset}`);
      },
      onPermission: async (event) => {
        spinner.stop(true);

        if (autoApprove) {
          await client.answerPermission(event.id, true);
          return;
        }

        renderSecurityPrompt({
          tool: event.tool,
          args: event.args,
          reason: event.reason
        });

        const ans = await promptWithAutocomplete({
          header: '',
          arrow: `\n  ${c.bold}Authorize execution? (y/N): ${c.reset}`
        });

        const allow = ans.trim().toLowerCase() === 'y' || ans.trim().toLowerCase() === 'yes';
        if (allow) {
          console.log(`  ${c.green}✔ Action authorized.${c.reset}\n`);
        } else {
          console.log(`  ${c.red}✖ Action denied by user.${c.reset}\n`);
        }
        await client.answerPermission(event.id, allow);
      },
      onDone: (doneData) => {
        spinner.stop(true);
        if (tokenStreamStarted) {
          process.stdout.write('\n');
        }
        const duration = ((Date.now() - turnStartTime) / 1000).toFixed(1);
        if (doneData.usage) {
          const u = doneData.usage;
          const promptFmt = (u.prompt_tokens || 0).toLocaleString();
          const compFmt = (u.completion_tokens || 0).toLocaleString();
          const totalFmt = (u.total_tokens || 0).toLocaleString();
          console.log(`  ${c.dim}╰─ ( ^_- )v✨ [${c.cyan}${totalFmt} tokens${c.dim} (${promptFmt} in / ${compFmt} out) • ${duration}s elapsed]${c.reset}\n`);
        } else {
          console.log(`  ${c.dim}╰─ ( ^_- )v✨ [Turn selesai dalam ${duration}s]${c.reset}\n`);
        }
      },
      onError: (errData) => {
        spinner.fail(`( T_T ) c( つ💔 Execution Error: ${errData.message}`);
        console.log('');
      }
    });

    // Auto-checkpoint after each turn in build mode
    if (client.sessionData.mode === 'build') {
      await snapshotManager.createCheckpoint('after-turn');
    }
  };

  // If a single inline prompt was provided without "run", execute turn and exit
  if (parsed.prompt) {
    try {
      await executeTurn(parsed.prompt, true);
    } finally {
      await cleanup();
    }
    return;
  }

  // Display initial welcome banner
  const branch = await snapshotManager.getCurrentBranch();
  renderBanner({
    sessionId: client.sessionId,
    mode: client.sessionData.mode,
    model: client.sessionData.model,
    serverUrl,
    gitBranch: branch
  });

  const commandHistory = [];

  // Main Interactive Loop
  while (true) {
    const s = client.sessionData;
    const modeBadge = s.mode === 'plan'
      ? `${c.bgYellow}${c.black}${c.bold} PLAN ${c.reset}`
      : `${c.bgGreen}${c.black}${c.bold} BUILD ${c.reset}`;
    const curBranch = (await snapshotManager.getCurrentBranch()) || 'main';
    const modelTag = `${c.cyan}${c.bold}${s.model || 'default'}${c.reset}`;
    const shortId = client.sessionId ? client.sessionId.slice(0, 16) + '…' : '';

    // Modern Starship / Claude Code 2-line prompt with real-time slash suggestions
    const header = `${c.dim}╭─${c.reset} ${modeBadge} ${c.magenta} ${curBranch}${c.reset} ${c.dim}•${c.reset} ${modelTag} ${c.dim}(${shortId})${c.reset}\n`;
    const arrow = `${c.dim}╰─${c.reset}${c.cyan}${c.bold}❯${c.reset} `;

    const input = await promptWithAutocomplete({
      header,
      arrow,
      history: commandHistory
    });

    let trimmed = input.trim();
    if (!trimmed) continue;

    // A bare slash opens the searchable command palette. This also works in
    // non-TTY terminals, where inline keypress autocomplete is unavailable.
    if (trimmed === '/') {
      const commandOptions = COMMANDS_REGISTRY
        .filter(command => command.cmd.startsWith('/'))
        .map(command => ({
          label: command.cmd,
          desc: command.desc,
          category: command.cat
        }));

      const selectedIndex = await promptSelect({
        title: 'COMMAND PALETTE',
        icon: '⌘',
        options: commandOptions,
        searchable: true,
        maxVisible: 14,
        footer: '↑↓ navigate • type to search • Enter run • Esc close'
      });

      if (selectedIndex < 0) continue;
      const selectedCommand = COMMANDS_REGISTRY.filter(command => command.cmd.startsWith('/'))[selectedIndex];
      if (!selectedCommand) continue;

      trimmed = selectedCommand.cmd;
      if (selectedCommand.needsArg) {
        const argument = await promptText({
          message: `Arguments for ${selectedCommand.cmd}`,
          validate: value => value.trim() ? undefined : 'This command requires an argument'
        });
        if (argument === null) continue;
        trimmed = `${selectedCommand.cmd} ${argument.trim()}`;
      }
    }

    commandHistory.push(trimmed);

    // Exit
    if (trimmed === 'exit' || trimmed === 'quit' || trimmed === '/exit' || trimmed === '/quit') {
      await cleanup();
      console.log(`\n  ( ˘ᴗ˘ )v ${c.cyan}Sampai jumpa! 👋 Nexus session closed.${c.reset}\n`);
      return;
    }

    // Help / Command list
    if (trimmed === '/' || trimmed === '/help') {
      renderCommandList();
      continue;
    }

    // Plan mode
    if (trimmed === '/plan') {
      await client.updateSessionSettings({ mode: 'plan' });
      console.log(`\n  🔒 ${c.yellow}${c.bold}Switched to PLAN mode${c.reset} ${c.dim}(read-only). File modifications blocked.${c.reset}\n`);
      continue;
    }

    // Build mode
    if (trimmed === '/build') {
      await client.updateSessionSettings({ mode: 'build' });
      console.log(`\n  ⚡ ${c.green}${c.bold}Switched to BUILD mode${c.reset} ${c.dim}(full execution). File writes & bash enabled.${c.reset}\n`);
      continue;
    }

    // OpenCode-style model picker: searchable model catalog grouped by provider.
    if (trimmed === '/model' || trimmed === '/model list' || trimmed === '/models') {
      spinner.start('Loading models from connected providers...');
      try {
        const catalog = await listAllModels();
        spinner.stop(true);
        if (!catalog.models.length) {
          const errors = catalog.errors.map(item => item.providerId + ': ' + item.error).join('\n');
          console.log('\n  No models available yet. Connect a provider with /connect or /provider first.');
          if (errors) console.log('  ' + errors);
          console.log('');
          continue;
        }
        const selected = await promptSelect({
          title: 'SELECT MODEL',
          icon: '◈',
          searchable: true,
          maxVisible: 12,
          options: catalog.models.map(model => ({
            label: model.model,
            desc: model.id,
            category: model.providerLabel,
            active: model.id === client.sessionData.model
          })),
          footer: '↑↓ navigate • Enter select • Esc cancel'
        });
        if (selected >= 0) {
          const model = catalog.models[selected];
          await client.updateSessionSettings({ model: model.id });
          console.log('\n  Active model: ' + c.cyan + model.id + c.reset + '\n');
        }
      } catch (err) {
        spinner.fail('Model discovery failed: ' + err.message);
      }
      continue;
    }

    if (trimmed.startsWith('/model ')) {
      const newModel = trimmed.slice(7).trim();
      try {
        await client.updateSessionSettings({ model: newModel });
        console.log('\n  Model aktif: ' + c.cyan + newModel + c.reset + '\n');
      } catch (err) {
        console.log('\n  ' + c.red + 'Gagal mengganti model: ' + err.message + c.reset + '\n');
      }
      continue;
    }

    // Provider registry: custom gateways are configured locally; secrets stay in environment variables.
    if (trimmed.startsWith('/provider add ')) {
      const parts = trimmed.slice('/provider add'.length).trim().split(/\s+/);
      const [id, baseUrl, apiKeyEnv, modelToken = '', ...labelParts] = parts;
      if (!id || !baseUrl || !apiKeyEnv) {
        console.log('\n  Usage: /provider add <id> <base_url> <api_key_env> [default_model|-] [label...]');
        console.log('  Example: /provider add openrouter https://openrouter.ai/api/v1 OPENROUTER_API_KEY - OpenRouter\n');
        continue;
      }
      try {
        const provider = addProvider({
          id,
          baseUrl,
          apiKeyEnv,
          defaultModel: modelToken === '-' ? '' : modelToken,
          label: labelParts.join(' ') || id
        });
        console.log('\n  Provider saved locally: ' + c.cyan + provider.id + c.reset);
        console.log('  API key reference: ' + provider.apiKeyEnv + (process.env[provider.apiKeyEnv] ? ' (available)' : ' (not set)'));
        console.log('  Set that variable in your private .env or shell environment. No key is stored in the repository.\n');
      } catch (err) {
        console.log('\n  ' + c.red + 'Gagal menambahkan provider: ' + err.message + c.reset + '\n');
      }
      continue;
    }

    if (trimmed.startsWith('/provider remove ')) {
      const id = trimmed.slice('/provider remove'.length).trim();
      const removed = removeProvider(id);
      console.log(removed
        ? '\n  Provider ' + id + ' removed from local registry.\n'
        : '\n  Provider not found in the local registry (environment-managed providers cannot be removed here).\n');
      continue;
    }

    if (trimmed === '/provider list') {
      const providers = getProviderCatalog(client.sessionData.model);
      if (!providers.length) {
        console.log('\n  No connected providers. Run /connect to connect one.\n');
      } else {
        console.log('\n  CONFIGURED PROVIDERS');
        for (const provider of providers) {
          console.log('  • ' + provider.label + ' (' + provider.id + ')' +
            (provider.active ? ' ◀ active' : '') +
            ' — ' + (provider.configured ? 'API key ready' : 'missing ' + provider.keyVariable) +
            ' — ' + provider.baseUrl);
        }
        console.log('');
      }
      continue;
    }

    // Provider connection picker. Credentials are entered masked and stored outside the repository.
    if (trimmed === '/provider' || trimmed === '/connect') {
      const providers = getProviderPickerCatalog(client.sessionData.model);
      const options = [
        ...providers.map(provider => ({
          label: provider.label,
          desc: provider.baseUrl,
          category: provider.category,
          connected: provider.connected,
          active: provider.active,
          id: provider.id
        })),
        { id: '__custom__', label: 'Custom OpenAI-compatible provider', desc: 'Connect a compatible API endpoint', category: 'Custom' }
      ];
      const selectedIndex = await promptSelect({
        title: 'CONNECT PROVIDER',
        icon: '🔌',
        options,
        searchable: true,
        maxVisible: 12,
        footer: '↑↓ navigate • type to search • Enter connect • Esc cancel'
      });
      if (selectedIndex < 0) continue;
      const selectedProvider = options[selectedIndex];

      if (selectedProvider.id === '__custom__') {
        const id = await promptText({
          message: 'Provider ID',
          validate: value => /^[a-z0-9][a-z0-9_-]{0,47}$/i.test(value.trim()) ? undefined : 'Use letters, numbers, - or _'
        });
        if (!id) continue;
        const label = await promptText({ message: 'Provider name', initialValue: id });
        if (label === null) continue;
        const baseUrl = await promptText({
          message: 'API base URL',
          validate: value => {
            try {
              const url = new URL(value.trim());
              return ['https:', 'http:'].includes(url.protocol) ? undefined : 'Use an HTTP or HTTPS URL';
            } catch { return 'Enter a valid URL'; }
          }
        });
        if (!baseUrl) continue;
        let apiKey;
        try { apiKey = await promptSecret('API key'); }
        catch (error) { console.log('\n  ' + c.yellow + error.message + c.reset + '\n'); continue; }
        if (apiKey === null) continue;
        try {
          const provider = addLocalProvider({ id, label: label || id, baseUrl, apiKey });
          let count = 0;
          try { count = (await listProviderModels(provider.id)).length; } catch {}
          console.log('\n  Credential saved: ' + c.green + provider.label + c.reset);
          console.log('  ' + (count ? count + ' models discovered. Use /models to choose one.' : 'Use /models to discover available models.') + '\n');
        } catch (error) {
          console.log('\n  ' + c.red + 'Provider connection failed: ' + error.message + c.reset + '\n');
        }
        continue;
      }

      const provider = providers.find(item => item.id === selectedProvider.id);
      if (!provider) continue;
      if (provider.connected) {
        const action = await promptSelect({
          title: provider.label.toUpperCase(),
          options: [
            { label: 'Keep current connection', desc: 'Use the saved credentials', active: true },
            { label: 'Update API key', desc: 'Replace the saved API key' },
            { label: 'Disconnect', desc: 'Remove locally saved credentials' }
          ],
          footer: '↑↓ navigate • Enter confirm • Esc cancel'
        });
        if (action < 0 || action === 0) {
          console.log('\n  ' + provider.label + ' is already connected. Use /models to select a model.\n');
          continue;
        }
        if (action === 2) {
          const removed = disconnectProvider(provider.id);
          console.log(removed
            ? '\n  Disconnected ' + provider.label + '.\n'
            : '\n  No locally stored credential to remove. Environment credentials remain active.\n');
          continue;
        }
      }

      let apiKey;
      try { apiKey = await promptSecret(provider.label + ' API key'); }
      catch (error) { console.log('\n  ' + c.yellow + error.message + c.reset + '\n'); continue; }
      if (apiKey === null) continue;
      try {
        connectProvider(provider.id, apiKey);
        let count = 0;
        let discoveryError = '';
        try { count = (await listProviderModels(provider.id)).length; }
        catch (error) { discoveryError = error.message; }
        if (count) {
          console.log('\n  Connected: ' + c.green + provider.label + c.reset);
          console.log('  ' + count + ' models available. Run /models to choose one.');
        } else {
          console.log('\n  Credential saved for ' + c.cyan + provider.label + c.reset + '.');
          console.log('  Model discovery: ' + (discoveryError || 'No models returned') + '. You can still try /models.');
        }
        console.log('');
      } catch (error) {
        console.log('\n  ' + c.red + 'Provider connection failed: ' + error.message + c.reset + '\n');
      }
      continue;
    }

    // Cost & Usage report
    if (trimmed === '/cost' || trimmed === '/usage') {
      try {
        const loaded = await client.loadSession(client.sessionId);
        const config = getModelConfig(client.sessionData.model);
        renderCostReport(loaded, config);
      } catch (err) {
        console.log(`\n  ${c.red}✖ Failed to load cost data:${c.reset} ${err.message}\n`);
      }
      continue;
    }

    // Context compaction
    if (trimmed === '/compact') {
      spinner.start('Compacting conversation context history...');
      try {
        const res = await client.compactSession();
        if (res.compacted) {
          spinner.succeed(`Context compacted: ${res.beforeTokens.toLocaleString()} -> ${res.afterTokens.toLocaleString()} tokens (${c.green}saved ${res.savedTokens.toLocaleString()} tokens${c.reset})`);
        } else {
          spinner.info(res.message || 'Context history is already compact.');
        }
        console.log('');
      } catch (err) {
        spinner.fail(`Compaction failed: ${err.message}`);
        console.log('');
      }
      continue;
    }

    // Git Diff
    if (trimmed === '/diff') {
      const diffRes = await snapshotManager.getDiff();
      if (!diffRes.success) {
        console.log(`\n  ${c.amber}⚠️  ${diffRes.message}${c.reset}\n`);
      } else if (!diffRes.diff && !diffRes.status) {
        console.log(`\n  ${c.green}✔ Working directory clean.${c.reset} No unstaged or modified files.\n`);
      } else {
        console.log(`\n${c.cyan}╭── 📂 WORKSPACE DIFF (vs ${diffRes.compareRef}) ─────────────────────────────╮${c.reset}`);
        if (diffRes.status) {
          console.log(`${c.cyan}│${c.reset}  ${c.bold}Modified files:${c.reset}`);
          for (const sLine of diffRes.status.split('\n')) {
            if (sLine.trim()) console.log(`${c.cyan}│${c.reset}    ${c.amber}${sLine}${c.reset}`);
          }
        }
        if (diffRes.diff) {
          console.log(`${c.cyan}├─────────────────────────────────────────────────────────────────────────────┤${c.reset}`);
          for (const line of diffRes.diff.split('\n')) {
            if (line.startsWith('+') && !line.startsWith('+++')) {
              console.log(`${c.cyan}│${c.reset} ${c.green}${line}${c.reset}`);
            } else if (line.startsWith('-') && !line.startsWith('---')) {
              console.log(`${c.cyan}│${c.reset} ${c.red}${line}${c.reset}`);
            } else if (line.startsWith('@@')) {
              console.log(`${c.cyan}│${c.reset} ${c.cyan}${line}${c.reset}`);
            } else {
              console.log(`${c.cyan}│${c.reset} ${c.dim}${line}${c.reset}`);
            }
          }
        }
        console.log(`${c.cyan}╰─────────────────────────────────────────────────────────────────────────────╯${c.reset}\n`);
      }
      continue;
    }

    // Doctor / Diagnostics
    if (trimmed === '/doctor') {
      spinner.start('Running system diagnostic health checks...');
      const isGit = await isGitRepo(process.cwd());
      const hasDocker = await isDockerAvailable();
      const activeModel = client.sessionData.model;
      const providerName = activeModel.includes('/') ? activeModel.split('/')[0] : 'openai-compatible';
      const hasKey = Boolean(process.env.API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY);

      let subagentsCount = 0;
      try {
        const agentsDir = path.resolve(process.cwd(), '.agent', 'agents');
        if (fs.existsSync(agentsDir)) {
          subagentsCount = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md')).length;
        }
      } catch {}

      const auditPath = path.resolve(process.cwd(), '.agent', 'audit.log');
      const hasAudit = fs.existsSync(auditPath);

      spinner.stop(true);
      renderDoctorReport({
        nodeOk: parseInt(process.versions.node.split('.')[0], 10) >= 20,
        gitOk: isGit,
        gitStatus: isGit ? 'Initialized git repository' : 'Not a git repo (run git init)',
        dockerOk: hasDocker,
        dockerStatus: hasDocker ? 'Available (sandbox enabled)' : 'Host exec mode (daemon offline)',
        modelOk: true,
        model: activeModel,
        provider: providerName,
        apiKeyOk: hasKey,
        apiKeyStatus: hasKey ? 'Configured in environment' : 'Missing (set API_KEY in .env)',
        toolsCount: defaultRegistry.list().length,
        agentsCount: subagentsCount,
        auditOk: hasAudit,
        auditStatus: hasAudit ? `Present (${path.basename(auditPath)})` : 'Will create upon first tool call',
        allHealthy: isGit && hasKey
      });
      continue;
    }

    // Init workspace
    if (trimmed === '/init') {
      try {
        const dirs = [
          path.resolve(process.cwd(), '.agent', 'agents'),
          path.resolve(process.cwd(), '.agent', 'commands'),
          path.resolve(process.cwd(), '.agent', 'plugins'),
          path.resolve(process.cwd(), '.agent', 'sessions')
        ];
        for (const dir of dirs) {
          fs.mkdirSync(dir, { recursive: true });
        }

        const configPath = path.resolve(process.cwd(), 'agent.config.json');
        if (!fs.existsSync(configPath)) {
          const defaultConfig = {
            $schema: './schemas/agent.config.schema.json',
            permissions: {
              tools: {
                read_file: 'allow',
                grep: 'allow',
                glob: 'allow',
                write_file: 'ask',
                edit_file: 'ask',
                bash: 'ask'
              },
              bash: [
                { pattern: '^git\\s+(status|diff|log|branch)', action: 'allow' },
                { pattern: '^(npm|node)\\s+--test', action: 'allow' },
                { pattern: '^npm\\s+test', action: 'allow' },
                { pattern: '^rm\\b', action: 'ask' },
                { pattern: '^sudo\\b', action: 'deny' }
              ]
            }
          };
          fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), 'utf8');
        }

        console.log(`\n  ${c.green}✔ Workspace initialized for Nexus Agent.${c.reset}`);
        console.log(`  ${c.dim}Directories:${c.reset} .agent/{agents, commands, plugins, sessions}`);
        console.log(`  ${c.dim}Config:${c.reset}      agent.config.json\n`);
      } catch (err) {
        console.log(`\n  ${c.red}✖ Failed to init:${c.reset} ${err.message}\n`);
      }
      continue;
    }

    // New session
    if (trimmed === '/new') {
      const fresh = await client.createSession({ mode: 'build', model: client.sessionData.model });
      console.log(`\n  ✨ ${c.green}${c.bold}Fresh session initialized:${c.reset} ${c.cyan}${fresh.id}${c.reset}\n`);
      continue;
    }

    // List sessions
    if (trimmed === '/sessions') {
      const list = await client.listSessions();
      console.log(`\n${c.cyan}╭── 💬 SAVED CONVERSATION SESSIONS ──────────────────────────────────────────╮${c.reset}`);
      for (const s of list) {
        const activeMark = s.id === client.sessionId ? ` ${c.green}${c.bold}◀ ACTIVE${c.reset}` : '';
        const dateStr = new Date(s.updatedAt).toLocaleString();
        const modeTag = s.mode === 'plan' ? `${c.yellow}[PLAN]${c.reset}` : `${c.green}[BUILD]${c.reset}`;
        console.log(`${c.cyan}│${c.reset}  ${c.bold}${s.id}${c.reset}${activeMark}`);
        console.log(`${c.cyan}│${c.reset}    ${modeTag} ${c.dim}Model:${c.reset} ${c.cyan}${s.model || 'default'}${c.reset} ${c.dim}• ${s.messageCount} msgs • ${(s.tokens || 0).toLocaleString()} tok • ${dateStr}${c.reset}`);
      }
      console.log(`${c.cyan}╰────────────────────────────────────────────────────────────────────────────╯${c.reset}\n`);
      continue;
    }

    // Resume session
    if (trimmed.startsWith('/resume')) {
      const targetId = trimmed.slice(7).trim();
      if (!targetId) {
        console.log(`\n  ${c.dim}Usage: /resume <session_id>${c.reset}\n`);
      } else {
        try {
          const resumed = await client.loadSession(targetId);
          console.log(`\n  📂 ${c.green}${c.bold}Resumed session:${c.reset} ${c.cyan}${resumed.id}${c.reset} ${c.dim}(${resumed.messages?.length || 0} messages loaded)${c.reset}\n`);
        } catch (err) {
          console.log(`\n  ${c.red}✖ Failed to resume:${c.reset} ${err.message}\n`);
        }
      }
      continue;
    }

    // Clear screen
    if (trimmed === '/clear') {
      console.clear();
      const curBranch = await snapshotManager.getCurrentBranch();
      renderBanner({
        sessionId: client.sessionId,
        mode: client.sessionData.mode,
        model: client.sessionData.model,
        serverUrl,
        gitBranch: curBranch
      });
      continue;
    }

    // Undo
    if (trimmed === '/undo') {
      const res = await snapshotManager.undo();
      if (res.success) {
        console.log(`\n  ↩️  ${c.green}${res.message}${c.reset}\n`);
      } else {
        console.log(`\n  ⚠️  ${c.yellow}${res.message}${c.reset}\n`);
      }
      continue;
    }

    // Redo
    if (trimmed === '/redo') {
      const res = await snapshotManager.redo();
      if (res.success) {
        console.log(`\n  ↪️  ${c.green}${res.message}${c.reset}\n`);
      } else {
        console.log(`\n  ⚠️  ${c.yellow}${res.message}${c.reset}\n`);
      }
      continue;
    }

    // List checkpoints
    if (trimmed === '/checkpoints') {
      const cps = snapshotManager.listCheckpoints();
      if (cps.length === 0) {
        console.log(`\n  ${c.dim}No checkpoints captured in this session yet.${c.reset}\n`);
      } else {
        console.log(`\n${c.cyan}╭── 📌 GIT CHECKPOINTS HISTORY ──────────────────────────────────────────────╮${c.reset}`);
        for (const cp of cps) {
          const marker = cp.current ? ` ${c.green}${c.bold}◀ current${c.reset}` : '';
          const dateStr = new Date(cp.timestamp).toLocaleTimeString();
          console.log(`${c.cyan}│${c.reset}  [${cp.index}] ${c.bold}${cp.ref}${c.reset} "${c.cyan}${cp.label}${c.reset}" ${c.dim}${dateStr}${c.reset}${marker}`);
        }
        console.log(`${c.cyan}╰────────────────────────────────────────────────────────────────────────────╯${c.reset}\n`);
      }
      continue;
    }

    // Create manual checkpoint
    if (trimmed.startsWith('/checkpoint')) {
      const label = trimmed.slice(11).trim() || undefined;
      const res = await snapshotManager.createCheckpoint(label);
      if (res.success) {
        console.log(`\n  📌 ${c.green}Checkpoint created:${c.reset} [${res.index}] ${c.bold}${res.ref}${c.reset} "${c.cyan}${res.label}${c.reset}"\n`);
      } else {
        console.log(`\n  ⚠️  ${c.yellow}${res.message}${c.reset}\n`);
      }
      continue;
    }

    // Export session to HTML
    if (trimmed.startsWith('/export')) {
      const outputArg = trimmed.slice(7).trim();
      const outputPath = outputArg || `nexus-session-${client.sessionId}.html`;
      try {
        const sessionData = await client.loadSession(client.sessionId);
        exportSessionToHTML(sessionData, outputPath);
        console.log(`\n  📄 ${c.green}Session exported to HTML:${c.reset} ${c.bold}${path.resolve(outputPath)}${c.reset}\n`);
      } catch (err) {
        console.log(`\n  ${c.red}✖ Export failed:${c.reset} ${err.message}\n`);
      }
      continue;
    }

    // Regular LLM conversation turn
    try {
      await executeTurn(trimmed, false);
    } catch (turnErr) {
      console.error(`\n  ${c.red}✖ Execution Error:${c.reset} ${turnErr.message}\n`);
    }
  }
}

// --- Main Entry ---

async function main() {
  const parsed = parseArgs(process.argv);

  if (parsed.command === 'run') {
    if (!parsed.prompt) {
      console.error('Error: nexus run requires a prompt argument.\nUsage: nexus run "your prompt" [--json] [--approve]');
      process.exit(1);
    }
    await runNonInteractive(parsed);
  } else {
    await runInteractive(parsed);
  }
}

main().catch((err) => {
  console.error('Fatal CLI Error:', err);
  process.exit(1);
});
