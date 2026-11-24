#!/usr/bin/env node

import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { createNexusServer } from './server.js';
import { SessionSnapshotManager } from './core/snapshot.js';
import { exportSessionToHTML } from './core/export.js';

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
      // Next non-flag arg is the prompt
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
    // Fallback: treat first non-flag as prompt for inline single-turn
    if (!parsed.prompt && !arg.startsWith('--')) {
      parsed.prompt = arg;
    }
    i++;
  }
  return parsed;
}

function printHelp() {
  console.log(`
Nexus Coding Agent CLI

Usage:
  nexus                           Interactive mode
  nexus run "prompt" [options]    Non-interactive single-turn (CI-friendly)

Options (run mode):
  --json         Structured JSON output to stdout
  --approve, -y  Auto-approve all permission requests
  --model <m>    Override model
  --mode <m>     build (default) or plan

Slash Commands (interactive):
  /plan             Switch to PLAN mode (read-only)
  /build            Switch to BUILD mode (full execution)
  /new              Start a brand new session
  /sessions         List all saved sessions
  /resume <id>      Resume session by ID
  /model <name>     Change LLM model
  /undo             Undo to previous checkpoint
  /redo             Redo to next checkpoint
  /checkpoints      List all checkpoints in this session
  /checkpoint [l]   Create named checkpoint
  /export [path]    Export session to HTML file
  /clear            Clear screen
  /help             Show this help
  exit / quit       Exit
`);
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

// --- Non-Interactive Run Mode ---

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

// --- Interactive Mode ---

async function runInteractive(parsed) {
  let localServer = null;
  let serverUrl = process.env.NEXUS_SERVER_URL;
  const token = process.env.NEXUS_SERVER_TOKEN || null;
  const snapshotManager = new SessionSnapshotManager(process.cwd());

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

  const cleanup = async () => {
    if (localServer) {
      try { await localServer.close(); } catch {}
    }
  };

  const executeTurn = async (userInput, rl, autoApprove = false) => {
    let tokenStreamStarted = false;

    await client.sendMessage(userInput, {
      onToken: (tok) => {
        if (!tokenStreamStarted) {
          process.stdout.write('\n🤖 ');
          tokenStreamStarted = true;
        }
        process.stdout.write(tok);
      },
      onToolStart: (event) => {
        tokenStreamStarted = false;
        console.log(`\n⚙️ [call] ${event.name} (${JSON.stringify(event.args)})`);
      },
      onToolResult: (event) => {
        const snippet = event.output.length > 300
          ? event.output.slice(0, 300) + '...'
          : event.output;
        console.log(`📄 [result] ${snippet.replace(/\n/g, ' ')}`);
      },
      onPermission: async (event) => {
        if (autoApprove) {
          await client.answerPermission(event.id, true);
          return;
        }

        if (!rl) {
          await client.answerPermission(event.id, false);
          return;
        }

        rl.question(`\n⚠️ Permission confirmation required for [${event.tool}]:\n   Args: ${JSON.stringify(event.args)}\n   Allow execution? (y/N): `, async (ans) => {
          const allow = ans.trim().toLowerCase() === 'y' || ans.trim().toLowerCase() === 'yes';
          await client.answerPermission(event.id, allow);
        });
      },
      onDone: (doneData) => {
        if (tokenStreamStarted) {
          console.log('\n');
        }
        if (doneData.usage) {
          const u = doneData.usage;
          console.log(`📊 [Tokens: prompt ${u.prompt_tokens?.toLocaleString() || 0}, completion ${u.completion_tokens?.toLocaleString() || 0} | total ${u.total_tokens?.toLocaleString() || 0}]\n`);
        }
      },
      onError: (errData) => {
        console.error(`\n❌ Error: ${errData.message}\n`);
      }
    });

    // Auto-create checkpoint after each turn in build mode
    if (client.sessionData.mode === 'build') {
      await snapshotManager.createCheckpoint(`after-turn`);
    }
  };

  // If a prompt was passed as CLI arg (old style, not `run` command), run single turn
  const inlinePrompt = parsed.prompt;
  if (inlinePrompt) {
    try {
      await executeTurn(inlinePrompt, null, true);
    } finally {
      await cleanup();
    }
    return;
  }

  console.log('Nexus Coding Agent CLI');
  console.log(`Connected to Server: ${serverUrl}`);
  console.log(`Session: ${client.sessionId} | Mode: ${client.sessionData.mode} | Model: ${client.sessionData.model}`);
  console.log('Commands: /plan, /build, /undo, /redo, /checkpoints, /export, /help\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const promptUser = () => {
    const s = client.sessionData;
    const promptStr = `[${s.mode}:${s.model || 'default'}] nexus> `;

    rl.question(promptStr, async (input) => {
      const trimmed = input.trim();
      if (!trimmed) {
        promptUser();
        return;
      }
      if (trimmed === 'exit' || trimmed === 'quit') {
        rl.close();
        await cleanup();
        return;
      }

      if (trimmed === '/help') {
        printHelp();
        promptUser();
        return;
      }

      if (trimmed === '/plan') {
        client.sessionData.mode = 'plan';
        console.log('\n🔒 Switched to PLAN mode (read-only). File modifications blocked.\n');
        promptUser();
        return;
      }

      if (trimmed === '/build') {
        client.sessionData.mode = 'build';
        console.log('\n⚡ Switched to BUILD mode (full execution). File modifications enabled.\n');
        promptUser();
        return;
      }

      if (trimmed === '/new') {
        const fresh = await client.createSession({ mode: 'build', model: client.sessionData.model });
        console.log(`\n✨ Created fresh session: ${fresh.id}\n`);
        promptUser();
        return;
      }

      if (trimmed === '/sessions') {
        const list = await client.listSessions();
        console.log('\nSaved Sessions:');
        console.log('-----------------------------------------------------------------');
        for (const s of list) {
          const activeMark = s.id === client.sessionId ? ' (active)' : '';
          const dateStr = new Date(s.updatedAt).toLocaleString();
          console.log(`- ${s.id}${activeMark} | [${s.mode}] ${s.model || 'default'} | ${s.messageCount} msgs | ${s.tokens.toLocaleString()} tokens | ${dateStr}`);
        }
        console.log('-----------------------------------------------------------------\n');
        promptUser();
        return;
      }

      if (trimmed.startsWith('/resume')) {
        const targetId = trimmed.slice(7).trim();
        if (!targetId) {
          console.log('\nUsage: /resume <session_id>\n');
        } else {
          try {
            const resumed = await client.loadSession(targetId);
            console.log(`\n📂 Resumed session: ${resumed.id} (${resumed.messages?.length || 0} msgs)\n`);
          } catch (err) {
            console.log(`\n❌ ${err.message}\n`);
          }
        }
        promptUser();
        return;
      }

      if (trimmed.startsWith('/model')) {
        const newModel = trimmed.slice(6).trim();
        if (!newModel) {
          console.log(`\nCurrent model: ${client.sessionData.model}\nUsage: /model <model_name>\n`);
        } else {
          client.sessionData.model = newModel;
          console.log(`\n🎯 Model changed to: ${newModel}\n`);
        }
        promptUser();
        return;
      }

      if (trimmed === '/clear') {
        console.clear();
        console.log(`\n🧹 Screen cleared.\n`);
        promptUser();
        return;
      }

      // --- Undo/Redo/Checkpoints ---

      if (trimmed === '/undo') {
        const res = await snapshotManager.undo();
        if (res.success) {
          console.log(`\n↩️ ${res.message}\n`);
        } else {
          console.log(`\n⚠️ ${res.message}\n`);
        }
        promptUser();
        return;
      }

      if (trimmed === '/redo') {
        const res = await snapshotManager.redo();
        if (res.success) {
          console.log(`\n↪️ ${res.message}\n`);
        } else {
          console.log(`\n⚠️ ${res.message}\n`);
        }
        promptUser();
        return;
      }

      if (trimmed === '/checkpoints') {
        const cps = snapshotManager.listCheckpoints();
        if (cps.length === 0) {
          console.log('\nNo checkpoints available.\n');
        } else {
          console.log('\n📋 Checkpoints:');
          console.log('-------------------------------------------');
          for (const cp of cps) {
            const marker = cp.current ? ' ◀ current' : '';
            const dateStr = new Date(cp.timestamp).toLocaleString();
            console.log(`  [${cp.index}] ${cp.ref} "${cp.label}" ${dateStr}${marker}`);
          }
          console.log('-------------------------------------------\n');
        }
        promptUser();
        return;
      }

      if (trimmed.startsWith('/checkpoint')) {
        const label = trimmed.slice(11).trim() || undefined;
        const res = await snapshotManager.createCheckpoint(label);
        if (res.success) {
          console.log(`\n📌 Checkpoint created: [${res.index}] ${res.ref} "${res.label}"\n`);
        } else {
          console.log(`\n⚠️ ${res.message}\n`);
        }
        promptUser();
        return;
      }

      // --- Export ---

      if (trimmed.startsWith('/export')) {
        const outputArg = trimmed.slice(7).trim();
        const outputPath = outputArg || `nexus-session-${client.sessionId}.html`;
        try {
          // Load full session from server
          const sessionData = await client.loadSession(client.sessionId);
          exportSessionToHTML(sessionData, outputPath);
          console.log(`\n📄 Session exported to: ${path.resolve(outputPath)}\n`);
        } catch (err) {
          console.log(`\n❌ Export failed: ${err.message}\n`);
        }
        promptUser();
        return;
      }

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

// --- Main ---

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
