#!/usr/bin/env node

import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { createNexusServer } from './server.js';
import { SessionSnapshotManager } from './core/snapshot.js';

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

function printHelp() {
  console.log(`
Available Slash Commands:
  /plan             Switch to PLAN mode (read-only: files cannot be modified)
  /build            Switch to BUILD mode (full execution: read, write, edit, bash)
  /new              Start a brand new session
  /sessions         List all saved sessions from server
  /resume <id>      Resume an existing session by ID
  /model <name>     Change LLM model for current session
  /undo             Revert changes to git snapshot captured at start of session
  /clear            Clear screen and reset current conversation context
  /help             Show this help menu
  exit / quit       Exit the CLI
`);
}

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

    // Send the message POST request
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

async function main() {
  let localServer = null;
  let serverUrl = process.env.NEXUS_SERVER_URL;
  const token = process.env.NEXUS_SERVER_TOKEN || null;
  const snapshotManager = new SessionSnapshotManager(process.cwd());

  if (!serverUrl) {
    // Start local in-process server
    localServer = createNexusServer({
      port: 0, // Automatically assign free port
      host: '127.0.0.1',
      token,
      workingDir: process.cwd()
    });
    const info = await localServer.start();
    serverUrl = info.url;
  }

  const client = new NexusClient({ serverUrl, token });
  const initialModel = process.env.MODEL || 'Elaina-Free';
  const initialMode = 'build';

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
  };

  const cliArg = process.argv.slice(2).join(' ').trim();
  if (cliArg) {
    try {
      await executeTurn(cliArg, null, true);
    } finally {
      await cleanup();
    }
    return;
  }

  console.log('Nexus Coding Agent CLI (Tahap 5 - Client/Server Architecture)');
  console.log(`Connected to Server: ${serverUrl}`);
  console.log(`Session: ${client.sessionId} | Mode: ${client.sessionData.mode} | Model: ${client.sessionData.model}`);
  console.log('Commands: /plan, /build, /new, /sessions, /resume <id>, /model <name>, /undo, /clear, /help\n');

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

      if (trimmed === '/undo') {
        const res = await snapshotManager.restore();
        if (res.success) {
          console.log(`\n↩️ [Undo] ${res.message}\n`);
        } else {
          console.log(`\n⚠️ [Undo] ${res.message}\n`);
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

main().catch((err) => {
  console.error('Fatal CLI Error:', err);
  process.exit(1);
});
