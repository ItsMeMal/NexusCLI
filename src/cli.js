#!/usr/bin/env node

/**
 * Nexus Coding Agent CLI
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
  renderCostReport
} from './core/ui.js';

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

// All available slash commands for completion and list
const SLASH_COMMANDS = [
  '/plan',
  '/build',
  '/model',
  '/diff',
  '/compact',
  '/cost',
  '/usage',
  '/undo',
  '/redo',
  '/checkpoints',
  '/checkpoint',
  '/sessions',
  '/resume',
  '/new',
  '/export',
  '/doctor',
  '/init',
  '/clear',
  '/help',
  '/exit',
  '/quit'
];

function completer(line) {
  if (line.startsWith('/')) {
    const hits = SLASH_COMMANDS.filter((cmd) => cmd.startsWith(line.toLowerCase()));
    return [hits.length ? hits : SLASH_COMMANDS, line];
  }
  return [[], line];
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
  const model = parsed.model || process.env.MODEL || 'Elaina-Free';
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

// --- Interactive Mode with Animated UI ---

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
  const initialModel = parsed.model || process.env.MODEL || 'Elaina-Free';
  const initialMode = parsed.mode || 'build';

  await client.createSession({ mode: initialMode, model: initialModel });
  await snapshotManager.captureFirstSnapshot();

  const cleanup = async () => {
    spinner.stop(false);
    if (localServer) {
      try { await localServer.close(); } catch {}
    }
  };

  const executeTurn = async (userInput, rl, autoApprove = false) => {
    let tokenStreamStarted = false;
    spinner.start('Thinking...');

    await client.sendMessage(userInput, {
      onToken: (tok) => {
        if (!tokenStreamStarted) {
          spinner.stop(true);
          process.stdout.write(`\n${c.cyan}🤖 ${c.reset}`);
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
        const shortArgs = argsPreview.length > 50 ? argsPreview.slice(0, 50) + '...' : argsPreview;
        spinner.start(`Executing tool: ${c.cyan}${event.name}${c.reset} ${c.dim}${shortArgs}${c.reset}`);
      },
      onToolResult: (event) => {
        const outStr = String(event.output || '');
        const snippet = outStr.length > 80
          ? outStr.slice(0, 80).replace(/\r?\n/g, ' ') + '...'
          : outStr.replace(/\r?\n/g, ' ');
        spinner.succeed(`${c.bold}${event.name}${c.reset} → ${c.dim}${snippet || '(no output)'}${c.reset}`);
      },
      onPermission: async (event) => {
        spinner.stop(true);

        if (autoApprove) {
          await client.answerPermission(event.id, true);
          return;
        }

        if (!rl) {
          await client.answerPermission(event.id, false);
          return;
        }

        const argsStr = JSON.stringify(event.args, null, 2);
        console.log(`\n${c.yellow}⚠️  PERMISSION CONFIRMATION REQUIRED${c.reset}`);
        console.log(`   ${c.bold}Tool:${c.reset}   ${c.cyan}${event.tool}${c.reset}`);
        console.log(`   ${c.bold}Args:${c.reset}   ${c.dim}${argsStr.replace(/\n/g, '\n   ')}${c.reset}`);
        if (event.reason) {
          console.log(`   ${c.bold}Reason:${c.reset} ${c.yellow}${event.reason}${c.reset}`);
        }

        rl.question(`   ${c.bold}Allow execution? (y/N): ${c.reset}`, async (ans) => {
          const allow = ans.trim().toLowerCase() === 'y' || ans.trim().toLowerCase() === 'yes';
          if (allow) {
            console.log(`   ${c.green}✔ Action approved.${c.reset}\n`);
          } else {
            console.log(`   ${c.red}✖ Action denied.${c.reset}\n`);
          }
          await client.answerPermission(event.id, allow);
        });
      },
      onDone: (doneData) => {
        spinner.stop(true);
        if (tokenStreamStarted) {
          console.log('\n');
        }
        if (doneData.usage) {
          const u = doneData.usage;
          const promptFmt = (u.prompt_tokens || 0).toLocaleString();
          const compFmt = (u.completion_tokens || 0).toLocaleString();
          const totalFmt = (u.total_tokens || 0).toLocaleString();
          console.log(`${c.dim}📊 [Tokens: ${c.cyan}${promptFmt}${c.dim} in • ${c.cyan}${compFmt}${c.dim} out • ${c.bold}${totalFmt}${c.dim} total]${c.reset}\n`);
        }
      },
      onError: (errData) => {
        spinner.fail(`Error: ${errData.message}`);
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
      await executeTurn(parsed.prompt, null, true);
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

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer
  });

  const promptUser = () => {
    const s = client.sessionData;
    const modeBadge = s.mode === 'plan' ? `${c.yellow}plan${c.reset}` : `${c.green}build${c.reset}`;
    const modelTag = `${c.cyan}${s.model || 'default'}${c.reset}`;
    const promptStr = `${c.dim}[${modeBadge}${c.dim}:${modelTag}${c.dim}]${c.reset} ${c.bold}${c.brightWhite}nexus>${c.reset} `;

    rl.question(promptStr, async (input) => {
      const trimmed = input.trim();
      if (!trimmed) {
        promptUser();
        return;
      }

      // Exit
      if (trimmed === 'exit' || trimmed === 'quit' || trimmed === '/exit' || trimmed === '/quit') {
        rl.close();
        await cleanup();
        console.log(`\n${c.dim}Sampai jumpa! 👋${c.reset}\n`);
        return;
      }

      // Help / Command list (also trigger if user types just '/')
      if (trimmed === '/' || trimmed === '/help') {
        renderCommandList();
        promptUser();
        return;
      }

      // Plan mode
      if (trimmed === '/plan') {
        client.sessionData.mode = 'plan';
        console.log(`\n🔒 ${c.yellow}${c.bold}Switched to PLAN mode${c.reset} ${c.dim}(read-only). File modifications blocked.${c.reset}\n`);
        promptUser();
        return;
      }

      // Build mode
      if (trimmed === '/build') {
        client.sessionData.mode = 'build';
        console.log(`\n⚡ ${c.green}${c.bold}Switched to BUILD mode${c.reset} ${c.dim}(full execution). File modifications enabled.${c.reset}\n`);
        promptUser();
        return;
      }

      // Model switch / info
      if (trimmed.startsWith('/model')) {
        const newModel = trimmed.slice(6).trim();
        if (!newModel) {
          console.log(`\n${c.bold}Active Model:${c.reset} ${c.cyan}${client.sessionData.model}${c.reset}`);
          console.log(`${c.dim}Usage: /model <name> (e.g. gpt-4o, claude-3-5-sonnet-20241022, gemini-1.5-flash)${c.reset}\n`);
        } else {
          client.sessionData.model = newModel;
          console.log(`\n🎯 ${c.bold}Model changed to:${c.reset} ${c.cyan}${newModel}${c.reset}\n`);
        }
        promptUser();
        return;
      }

      // Cost & Usage report
      if (trimmed === '/cost' || trimmed === '/usage') {
        try {
          const loaded = await client.loadSession(client.sessionId);
          const config = getModelConfig(client.sessionData.model);
          renderCostReport(loaded, config);
        } catch (err) {
          console.log(`\n❌ Failed to load cost data: ${err.message}\n`);
        }
        promptUser();
        return;
      }

      // Context compaction
      if (trimmed === '/compact') {
        spinner.start('Compacting conversation context...');
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
        promptUser();
        return;
      }

      // Git Diff
      if (trimmed === '/diff') {
        const diffRes = await snapshotManager.getDiff();
        if (!diffRes.success) {
          console.log(`\n⚠️ ${diffRes.message}\n`);
        } else if (!diffRes.diff && !diffRes.status) {
          console.log(`\n${c.green}✔ Working directory clean.${c.reset} No unstaged or modified files.\n`);
        } else {
          console.log(`\n${c.bold}${c.cyan}WORKSPACE DIFF (vs ${diffRes.compareRef}):${c.reset}`);
          console.log('─'.repeat(50));
          if (diffRes.status) {
            console.log(`${c.bold}Modified files:${c.reset}\n${diffRes.status}\n`);
          }
          if (diffRes.diff) {
            for (const line of diffRes.diff.split('\n')) {
              if (line.startsWith('+') && !line.startsWith('+++')) {
                console.log(`${c.green}${line}${c.reset}`);
              } else if (line.startsWith('-') && !line.startsWith('---')) {
                console.log(`${c.red}${line}${c.reset}`);
              } else if (line.startsWith('@@')) {
                console.log(`${c.cyan}${line}${c.reset}`);
              } else {
                console.log(line);
              }
            }
          }
          console.log('─'.repeat(50) + '\n');
        }
        promptUser();
        return;
      }

      // Doctor / Diagnostics
      if (trimmed === '/doctor') {
        spinner.start('Running diagnostic health checks...');
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
          dockerStatus: hasDocker ? 'Available (sandbox enabled)' : 'Not installed / daemon offline (fallback to host exec)',
          modelOk: true,
          model: activeModel,
          provider: providerName,
          apiKeyOk: hasKey,
          apiKeyStatus: hasKey ? 'Configured in environment' : 'Missing (set API_KEY in .env)',
          toolsCount: defaultRegistry.list().length,
          agentsCount: subagentsCount,
          auditOk: hasAudit,
          auditStatus: hasAudit ? `Present (${path.basename(auditPath)})` : 'Will be created upon first tool call',
          allHealthy: isGit && hasKey
        });
        promptUser();
        return;
      }

      // Init workspace
      if (trimmed === '/init') {
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

        console.log(`\n${c.green}✔ Workspace initialized for Nexus Agent.${c.reset}`);
        console.log(`  ${c.dim}Directories:${c.reset} .agent/{agents, commands, plugins, sessions}`);
        console.log(`  ${c.dim}Config:${c.reset}      agent.config.json\n`);
        promptUser();
        return;
      }

      // New session
      if (trimmed === '/new') {
        const fresh = await client.createSession({ mode: 'build', model: client.sessionData.model });
        console.log(`\n✨ ${c.green}${c.bold}Fresh session created:${c.reset} ${c.cyan}${fresh.id}${c.reset}\n`);
        promptUser();
        return;
      }

      // List sessions
      if (trimmed === '/sessions') {
        const list = await client.listSessions();
        console.log(`\n${c.bold}${c.cyan}SAVED SESSIONS${c.reset}`);
        console.log('─'.repeat(70));
        for (const s of list) {
          const activeMark = s.id === client.sessionId ? ` ${c.green}◀ active${c.reset}` : '';
          const dateStr = new Date(s.updatedAt).toLocaleString();
          const modeTag = s.mode === 'plan' ? `${c.yellow}[plan]${c.reset}` : `${c.green}[build]${c.reset}`;
          console.log(`- ${c.bold}${s.id}${c.reset}${activeMark} | ${modeTag} ${c.dim}${s.model || 'default'}${c.reset} | ${s.messageCount} msgs | ${s.tokens.toLocaleString()} tok | ${c.dim}${dateStr}${c.reset}`);
        }
        console.log('─'.repeat(70) + '\n');
        promptUser();
        return;
      }

      // Resume session
      if (trimmed.startsWith('/resume')) {
        const targetId = trimmed.slice(7).trim();
        if (!targetId) {
          console.log(`\n${c.dim}Usage: /resume <session_id>${c.reset}\n`);
        } else {
          try {
            const resumed = await client.loadSession(targetId);
            console.log(`\n📂 ${c.green}${c.bold}Resumed session:${c.reset} ${c.cyan}${resumed.id}${c.reset} ${c.dim}(${resumed.messages?.length || 0} messages)${c.reset}\n`);
          } catch (err) {
            console.log(`\n❌ ${err.message}\n`);
          }
        }
        promptUser();
        return;
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
        promptUser();
        return;
      }

      // Undo
      if (trimmed === '/undo') {
        const res = await snapshotManager.undo();
        if (res.success) {
          console.log(`\n↩️ ${c.green}${res.message}${c.reset}\n`);
        } else {
          console.log(`\n⚠️ ${c.yellow}${res.message}${c.reset}\n`);
        }
        promptUser();
        return;
      }

      // Redo
      if (trimmed === '/redo') {
        const res = await snapshotManager.redo();
        if (res.success) {
          console.log(`\n↪️ ${c.green}${res.message}${c.reset}\n`);
        } else {
          console.log(`\n⚠️ ${c.yellow}${res.message}${c.reset}\n`);
        }
        promptUser();
        return;
      }

      // List checkpoints
      if (trimmed === '/checkpoints') {
        const cps = snapshotManager.listCheckpoints();
        if (cps.length === 0) {
          console.log(`\n${c.dim}No checkpoints available in this session.${c.reset}\n`);
        } else {
          console.log(`\n${c.bold}${c.cyan}GIT CHECKPOINTS${c.reset}`);
          console.log('─'.repeat(55));
          for (const cp of cps) {
            const marker = cp.current ? ` ${c.green}◀ current${c.reset}` : '';
            const dateStr = new Date(cp.timestamp).toLocaleTimeString();
            console.log(`  [${cp.index}] ${c.bold}${cp.ref}${c.reset} "${c.cyan}${cp.label}${c.reset}" ${c.dim}${dateStr}${c.reset}${marker}`);
          }
          console.log('─'.repeat(55) + '\n');
        }
        promptUser();
        return;
      }

      // Create manual checkpoint
      if (trimmed.startsWith('/checkpoint')) {
        const label = trimmed.slice(11).trim() || undefined;
        const res = await snapshotManager.createCheckpoint(label);
        if (res.success) {
          console.log(`\n📌 ${c.green}Checkpoint created:${c.reset} [${res.index}] ${c.bold}${res.ref}${c.reset} "${c.cyan}${res.label}${c.reset}"\n`);
        } else {
          console.log(`\n⚠️ ${c.yellow}${res.message}${c.reset}\n`);
        }
        promptUser();
        return;
      }

      // Export session to HTML
      if (trimmed.startsWith('/export')) {
        const outputArg = trimmed.slice(7).trim();
        const outputPath = outputArg || `nexus-session-${client.sessionId}.html`;
        try {
          const sessionData = await client.loadSession(client.sessionId);
          exportSessionToHTML(sessionData, outputPath);
          console.log(`\n📄 ${c.green}Session exported to:${c.reset} ${c.bold}${path.resolve(outputPath)}${c.reset}\n`);
        } catch (err) {
          console.log(`\n❌ Export failed: ${err.message}\n`);
        }
        promptUser();
        return;
      }

      // Regular LLM conversation turn
      try {
        await executeTurn(trimmed, rl, false);
      } catch (turnErr) {
        console.error(`\n❌ Error: ${turnErr.message}\n`);
      }

      promptUser();
    });
  };

  promptUser();
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
