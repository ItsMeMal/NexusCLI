import React, { useState, useEffect, useRef } from 'react';
import { render, Box, Text, Spacer, useInput, useApp, useStdin, useWindowSize } from 'ink';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { createNexusServer } from './server.js';
import { loadEnv } from './core/config.js';
import { SessionSnapshotManager, isGitRepo } from './core/snapshot.js';
import { exportSessionToHTML } from './core/export.js';
import { getModelConfig } from './core/context.js';
import { isDockerAvailable } from './core/sandbox.js';
import { defaultRegistry } from './tools/index.js';
import { COMMANDS_REGISTRY } from './core/prompt_input.js';
import { addProvider, getProviderCatalog, listAllModels, listProviderModels, removeProvider } from './core/providers/index.js';

const createElement = React.createElement;

// Load environment variables (.env)
loadEnv();

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const PAGE_SIZE = 6;

const ALL_COMMANDS = COMMANDS_REGISTRY.map(command => ({
  cmd: command.cmd,
  desc: command.desc,
  cat: command.cat,
  needsArg: command.needsArg
}));

const MASCOT_FRAMES = {
  idle: [
    {
      face: [' ∧,,∧  ', '( ˘ᴗ˘ ) ', 'c( つ🪄*'],
      color: 'magenta',
      quote: 'Siap membantu. Tulis apa yang ingin kamu lakukan, atau ketik / untuk commands~'
    },
    {
      face: [' ∧,,∧  ', '( ˘‿˘ ) ', 'c( つ🪄✨'],
      color: 'magenta',
      quote: 'Ada yang ingin dicari, dijelaskan, ditulis, dianalisis, atau dikerjakan?'
    }
  ],
  thinking: [
    {
      face: [' ∧,,∧  ', '( ✧ω✧) ', 'c( つ🪄✦'],
      color: 'yellow',
      quote: 'Memahami permintaan dan menyiapkan bantuan... ✦'
    },
    {
      face: [' ∧,,∧  ', '( ˘ω˘ ) ', 'c( つ🪄*'],
      color: 'yellow',
      quote: 'Menghitung jalur eksekusi paling efisien... ˚ *'
    },
    {
      face: [' ∧,,∧  ', '( ✧ᴗ✧) ', 'c( つ🪄˚'],
      color: 'yellow',
      quote: 'Menerima token jawaban streaming dari LLM... ✦ ˚'
    }
  ],
  tool: [
    {
      face: [' ∧,,∧  ', '( •̀_•́ ) ', 'c( つ📦⚡'],
      color: 'cyan',
      quote: 'Mengeksekusi tool sistem... ⚡'
    },
    {
      face: [' ∧,,∧  ', '( •̀ᴗ•́ ) ', 'c( つ📦✨'],
      color: 'cyan',
      quote: 'Mengevaluasi hasil eksekusi tool... ✨'
    }
  ],
  permission: [
    {
      face: [' ∧,,∧  ', '( ⊙_⊙ ) ', 'c( つ📜⚠'],
      color: 'red',
      quote: 'Tunggu! Tool ini berisiko. Tekan [Y] Izinkan  │  [N] Tolak.'
    }
  ],
  done: [
    {
      face: [' ∧,,∧  ', '( ^_- )v', 'c( つ✨ '],
      color: 'green',
      quote: 'Beres! Tugas berhasil diselesaikan dengan rapi~'
    }
  ],
  error: [
    {
      face: [' ∧,,∧  ', '( T_T ) ', 'c( つ💔 '],
      color: 'red',
      quote: 'Aduh, ada error teknis saat eksekusi...'
    }
  ]
};

// ─── TUI Client Class ─────────────────────────────────────────────────────────

class TUIClient {
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
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    this.sessionId = data.id;
    this.sessionData = data;
    return data;
  }

  async listSessions() {
    const res = await fetch(`${this.serverUrl}/session`, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  }

  async loadSession(id) {
    const res = await fetch(`${this.serverUrl}/session/${id}`, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    this.sessionId = data.id;
    this.sessionData = data;
    return data;
  }

  async abortSession(id) {
    const res = await fetch(`${this.serverUrl}/session/${id || this.sessionId}/abort`, {
      method: 'POST',
      headers: this.getHeaders()
    });
    return res.json();
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
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
      throw new Error(`SSE stream failed: HTTP ${sseRes.status}`);
    }

    const reader = sseRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const streamPromise = new Promise(async (resolve, reject) => {
      let currentEvent = null;
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
              let payload = {};
              try {
                payload = JSON.parse(dataStr);
              } catch {
                payload = { raw: dataStr };
              }

              const eventType = payload.type || currentEvent;

              if (eventType === 'text.delta') {
                onToken?.(payload.text || '');
              } else if (eventType === 'tool.start') {
                onToolStart?.(payload);
              } else if (eventType === 'tool.result') {
                onToolResult?.(payload);
              } else if (eventType === 'permission.request') {
                onPermission?.(payload);
              } else if (eventType === 'done') {
                onDone?.(payload);
                try { await reader.cancel(); } catch {}
                resolve(payload);
                return;
              } else if (eventType === 'error') {
                onError?.(payload);
                try { await reader.cancel(); } catch {}
                reject(new Error(payload.message || payload.error || 'Execution error'));
                return;
              }
              currentEvent = null;
            }
          }
        }
        resolve({});
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
      throw new Error(`Failed to send message (HTTP ${postRes.status}): ${errText}`);
    }

    return await streamPromise;
  }
}

// ─── Compact Mascot & Header Component ────────────────────────────────────────

function NexusCompactHeader({ session, agentStatus, tokenUsage, frameIndex, elapsedSeconds, gitBranch }) {
  const mode = session?.mode || 'build';
  const model = session?.model || 'No model selected';
  const stateKey = MASCOT_FRAMES[agentStatus.state] ? agentStatus.state : 'idle';
  const frames = MASCOT_FRAMES[stateKey];
  const currentFrame = frames[frameIndex % frames.length];

  const stepInfo = agentStatus.step ? ` [Step ${agentStatus.step}/25]` : '';
  const timeInfo = elapsedSeconds > 0 ? ` (${elapsedSeconds}s)` : '';
  const spinnerChar = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length];

  let statusBadge = '● IDLE';
  if (agentStatus.state === 'thinking') statusBadge = `${spinnerChar} THINKING${stepInfo}${timeInfo}`;
  if (agentStatus.state === 'tool') statusBadge = `⚡ TOOL [${agentStatus.toolName || 'exec'}]${stepInfo}${timeInfo}`;
  if (agentStatus.state === 'permission') statusBadge = `🛑 SECURITY GATE${stepInfo}`;
  if (agentStatus.state === 'done') statusBadge = '✔ COMPLETED';
  if (agentStatus.state === 'error') statusBadge = '✕ ERROR';

  const dialogue = agentStatus.text || currentFrame.quote;
  const mascotAvatar = currentFrame.face[1].trim() + (currentFrame.face[2].includes('✨') ? '✨' : '🪄');

  return createElement(Box, {
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor: currentFrame.color,
    paddingX: 1,
    paddingY: 0,
    marginY: 0
  },
    // Row 1: Brand + Status + Mode + Model + Git Branch + Tokens
    createElement(Box, { flexDirection: 'row' },
      createElement(Text, { color: currentFrame.color, bold: true }, '✦ NEXUS ORCHESTRATOR '),
      createElement(Text, { color: currentFrame.color, bold: true }, `[${statusBadge}]`),
      createElement(Spacer),
      createElement(Box, { paddingX: 1 },
        createElement(Text, {
          color: 'black',
          backgroundColor: mode === 'plan' ? 'yellow' : 'green',
          bold: true
        }, ` ${mode.toUpperCase()} `)
      ),
      createElement(Text, { color: 'cyan', bold: true }, `[${model}] `),
      gitBranch ? createElement(Text, { color: 'gray' }, `git:${gitBranch} │ `) : null,
      createElement(Text, { color: 'gray' }, `${(tokenUsage || 0).toLocaleString()} tok`)
    ),
    // Row 2: Mascot dialogue + Quick hint
    createElement(Box, { flexDirection: 'row' },
      createElement(Text, { color: currentFrame.color, bold: true }, `${mascotAvatar} `),
      createElement(Text, { color: 'white' }, `"${dialogue}"`),
      createElement(Spacer),
      createElement(Text, { color: 'gray', dimColor: true }, 'Ketik / untuk command palette')
    )
  );
}

function PermissionModal({ request }) {
  if (!request) return null;

  return createElement(Box, {
    borderStyle: 'double',
    borderColor: 'red',
    paddingX: 1,
    marginY: 0,
    flexDirection: 'column'
  },
    createElement(Text, { color: 'red', bold: true }, `⚠ SECURITY GATE: Tool [${request.tool}] butuh izinmu`),
    createElement(Text, { color: 'yellow' }, `  Args: ${JSON.stringify(request.args || {})}`),
    createElement(Text, { color: 'green', bold: true }, '  Tekan [ Y ] Izinkan  │  [ N ] Tolak')
  );
}

function MessagesArea({ messages, activeStream, maxRows }) {
  const recentMessages = messages.slice(-maxRows);

  return createElement(Box, {
    flexDirection: 'column',
    borderStyle: 'single',
    borderColor: 'gray',
    paddingX: 1,
    paddingY: 0,
    marginY: 0,
    minHeight: 4,
    flexGrow: 1
  },
    recentMessages.length === 0 && !activeStream
      ? createElement(Box, { paddingY: 0 },
          createElement(Text, { color: 'gray', dimColor: true }, 'Belum ada percakapan. Tulis pertanyaan atau tugas apa pun, atau ketik / untuk melihat commands.')
        )
      : null,

    ...recentMessages.map((msg, idx) => {
      if (msg.role === 'user') {
        return createElement(Box, { key: idx, marginY: 0 },
          createElement(Text, { color: 'cyan', bold: true }, '❯ You: '),
          createElement(Text, { color: 'white', bold: true }, msg.content)
        );
      }
      if (msg.role === 'assistant') {
        return createElement(Box, { key: idx, marginY: 0, flexDirection: 'column' },
          createElement(Text, { color: 'green', bold: true }, '🤖 Nexus AI:'),
          createElement(Text, { color: 'white' }, msg.content)
        );
      }
      if (msg.role === 'tool_call') {
        const argStr = typeof msg.args === 'string' ? msg.args : JSON.stringify(msg.args || {});
        const displayArg = argStr.length > 80 ? argStr.slice(0, 80) + '…' : argStr;
        return createElement(Box, {
          key: idx,
          borderStyle: 'round',
          borderColor: 'yellow',
          paddingX: 1,
          marginY: 0
        },
          createElement(Text, { color: 'yellow', bold: true }, `⚙ [Tool: ${msg.name}] `),
          createElement(Text, { color: 'gray' }, displayArg)
        );
      }
      if (msg.role === 'tool_result') {
        const preview = (msg.output || '').length > 120
          ? (msg.output || '').slice(0, 120).replace(/\r?\n/g, ' ') + '…'
          : (msg.output || '').replace(/\r?\n/g, ' ');
        return createElement(Box, { key: idx, paddingLeft: 2, marginY: 0 },
          createElement(Text, { color: 'green', dimColor: true }, `└─ Result: ${preview || '(empty)'}`)
        );
      }
      return null;
    }),

    // Live Streaming Token Block
    activeStream ? createElement(Box, { marginY: 0, flexDirection: 'column' },
      createElement(Text, { color: 'green', bold: true }, '🤖 Nexus AI (mengetik...):'),
      createElement(Text, { color: 'white' }, activeStream + ' █')
    ) : null
  );
}

// ─── Interactive Command Autocomplete Palette (Sliding Window Scrollable) ────

function CommandPalette({ commands, selectedIndex, scrollOffset, pageSize }) {
  if (!commands || commands.length === 0) return null;

  const visible = commands.slice(scrollOffset, scrollOffset + pageSize);
  const hasAbove = scrollOffset > 0;
  const hasBelow = scrollOffset + pageSize < commands.length;
  const aboveCount = scrollOffset;
  const belowCount = commands.length - (scrollOffset + pageSize);

  const catColors = {
    'Mode': 'yellow',
    'Git': 'green',
    'Model': 'magenta',
    'Session': 'blue',
    'System': 'red',
    'Help': 'cyan',
    'UI': 'gray'
  };

  return createElement(Box, {
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor: 'cyan',
    paddingX: 1,
    marginY: 0
  },
    // Header with live counter and controls
    createElement(Box, { flexDirection: 'row', marginBottom: 0 },
      createElement(Text, { color: 'cyan', bold: true }, '✦ COMMAND PALETTE '),
      createElement(Text, { color: 'white', bold: true }, `[${selectedIndex + 1}/${commands.length}] `),
      createElement(Spacer),
      createElement(Text, { color: 'gray', dimColor: true }, '↑/↓ Navigasi │ Tab Lengkapi │ Enter Pilih │ Esc Tutup')
    ),

    // Scroll up indicator
    hasAbove
      ? createElement(Box, { marginY: 0 },
          createElement(Text, { color: 'yellow', dimColor: true }, `  ▲ ... (${aboveCount} perintah lagi di atas)`)
        )
      : null,

    // Active visible window items
    ...visible.map((item, relIdx) => {
      const absIdx = scrollOffset + relIdx;
      const isSelected = absIdx === selectedIndex;
      const catColor = catColors[item.cat] || 'gray';

      return createElement(Box, { key: item.cmd, flexDirection: 'row' },
        createElement(Text, {
          color: isSelected ? 'black' : 'cyan',
          backgroundColor: isSelected ? 'cyan' : undefined,
          bold: isSelected
        }, `${isSelected ? '❯ ' : '  '}${item.cmd.padEnd(14, ' ')}`),
        createElement(Text, { color: catColor }, ` [${item.cat}] `),
        createElement(Text, {
          color: isSelected ? 'white' : 'gray',
          bold: isSelected
        }, item.desc)
      );
    }),

    // Scroll down indicator
    hasBelow
      ? createElement(Box, { marginY: 0 },
          createElement(Text, { color: 'yellow', dimColor: true }, `  ▼ ... (${belowCount} perintah lagi di bawah)`)
        )
      : null
  );
}

function ProviderPalette({ providers, selectedIndex }) {
  const options = [
    ...(providers || []).map(provider => ({
      id: provider.id, label: provider.label, configured: provider.configured,
      active: provider.active, detail: provider.baseUrl, keyVariable: provider.keyVariable
    })),
    { id: '__add__', label: '+ Add provider', configured: true, active: false, detail: 'Register any AI router or gateway' }
  ];
  return createElement(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'magenta', paddingX: 1, marginY: 0 },
    createElement(Box, { flexDirection: 'row' },
      createElement(Text, { color: 'magenta', bold: true }, '🔌 CONFIGURED PROVIDERS '),
      createElement(Spacer),
      createElement(Text, { color: 'gray', dimColor: true }, '↑/↓ pilih • Enter lanjut • Esc tutup')
    ),
    ...options.map((provider, index) => {
      const selected = index === selectedIndex;
      return createElement(Box, { key: provider.id, flexDirection: 'row' },
        createElement(Text, { color: selected ? 'black' : 'cyan', backgroundColor: selected ? 'magenta' : undefined, bold: selected },
          (selected ? '❯ ' : '  ') + provider.label.padEnd(24)),
        createElement(Text, { color: provider.configured ? 'green' : 'yellow' },
          provider.id === '__add__' ? 'NEW' : (provider.configured ? 'KEY READY' : 'MISSING KEY')),
        createElement(Spacer),
        createElement(Text, { color: provider.active ? 'green' : 'gray' }, provider.active ? '● ACTIVE' : ''),
        createElement(Text, { color: 'gray' }, '  ' + (provider.detail || ''))
      );
    }),
    createElement(Text, { color: 'gray', dimColor: true }, '  Add: /provider add <id> <base_url> <api_key_env> [default_model|-] [label...]')
  );
}

function ModelPalette({ models, selectedIndex }) {
  if (!models || models.length === 0) return null;
  return createElement(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', paddingX: 1, marginY: 0 },
    createElement(Box, { flexDirection: 'row' },
      createElement(Text, { color: 'cyan', bold: true }, '◈ AVAILABLE MODELS '),
      createElement(Spacer),
      createElement(Text, { color: 'gray', dimColor: true }, '↑/↓ pilih • Enter gunakan • Esc tutup')
    ),
    ...models.map((model, index) => {
      const selected = index === selectedIndex;
      return createElement(Box, { key: model.id, flexDirection: 'row' },
        createElement(Text, { color: selected ? 'black' : 'cyan', backgroundColor: selected ? 'cyan' : undefined, bold: selected },
          (selected ? '❯ ' : '  ') + model.model),
        createElement(Spacer),
        createElement(Text, { color: 'gray' }, model.providerLabel + '  ' + model.id)
      );
    })
  );
}

function InputBox({ input, mode, isBusy }) {
  return createElement(Box, {
    borderStyle: 'round',
    borderColor: isBusy ? 'yellow' : 'cyan',
    paddingX: 1,
    marginY: 0
  },
    createElement(Text, { color: 'cyan', bold: true }, `[${mode.toUpperCase()}] ❯ `),
    createElement(Text, { color: isBusy ? 'gray' : 'white' },
      input || (isBusy ? 'NexusAI sedang memproses... tunggu sejenak' : 'Tulis pertanyaan atau tugas apa pun, atau ketik / untuk commands...')
    ),
    !isBusy ? createElement(Text, { color: 'cyan' }, '█') : null
  );
}

function FooterBar() {
  return createElement(Box, { paddingX: 1, marginTop: 0 },
    createElement(Text, { color: 'gray', dimColor: true },
      'Perintah cepat: /help  /plan  /build  /diff  /doctor  /cost  /undo  /redo  /compact  exit'
    )
  );
}

// ─── Main TUI App Container ───────────────────────────────────────────────────

function NexusTUIApp({ client, snapshotManager }) {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const { rows } = useWindowSize();
  const [session, setSession] = useState(client.sessionData);
  const [messages, setMessages] = useState([]);
  const [activeStream, setActiveStream] = useState('');
  const [input, setInput] = useState('');
  const [selectedCmdIndex, setSelectedCmdIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [providerPickerOpen, setProviderPickerOpen] = useState(false);
  const [selectedProviderIndex, setSelectedProviderIndex] = useState(0);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelOptions, setModelOptions] = useState([]);
  const [selectedModelIndex, setSelectedModelIndex] = useState(0);
  const [tokenUsage, setTokenUsage] = useState(0);
  const [gitBranch, setGitBranch] = useState('');
  const [pendingPermission, setPendingPermission] = useState(null);
  const [agentStatus, setAgentStatus] = useState({ state: 'idle', text: '' });
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const isBusy = agentStatus.state === 'thinking' || agentStatus.state === 'tool' || agentStatus.state === 'permission';

  // Read git branch on mount
  useEffect(() => {
    snapshotManager.getCurrentBranch().then(b => setGitBranch(b || '')).catch(() => {});
  }, []);

  // Filter command suggestions based on current input
  const isSlashActive = input.startsWith('/');
  const filteredCommands = isSlashActive
    ? ALL_COMMANDS.filter(c => c.cmd.toLowerCase().startsWith(input.trim().toLowerCase().split(' ')[0]))
    : [];
  const providerOptions = getProviderCatalog(session?.model);
  const commandPageSize = input.trim() === '/' ? filteredCommands.length : PAGE_SIZE;

  // Reset scroll and selection index if query changes
  useEffect(() => {
    setSelectedCmdIndex(0);
    setScrollOffset(0);
  }, [input]);

  // Make room for the complete slash palette without hiding the input.
  const paletteRows = isSlashActive ? Math.min(filteredCommands.length + 3, Math.max(0, (rows || 28) - 7)) : 0;
  const maxMessageRows = Math.max(3, Math.min(20, (rows || 28) - (isSlashActive ? paletteRows + 4 : 8)));

  // Mascot & Animation effect
  useEffect(() => {
    if (agentStatus.state === 'idle') {
      const idleInterval = setInterval(() => {
        setSpinnerFrame(f => (f + 1) % 2);
      }, 2500);
      return () => clearInterval(idleInterval);
    }

    if (agentStatus.state === 'thinking' || agentStatus.state === 'tool') {
      const activeInterval = setInterval(() => {
        setSpinnerFrame(f => (f + 1) % 12);
        setElapsedSeconds(s => s + 1);
      }, 300);
      return () => clearInterval(activeInterval);
    }
  }, [agentStatus.state]);

  // Execute User Turn or Slash Command
  const handleExecute = async (userPrompt) => {
    if (isBusy) return;
    const trimmed = userPrompt.trim();
    if (!trimmed) return;

    // ─── Slash command handling ───────────────────────────────────────────

    // /help or just /
    if (trimmed === '/help' || trimmed === '/') {
      const helpText = `AVAILABLE COMMANDS:
      ${ALL_COMMANDS.map(command => `${command.cmd.padEnd(14)} ${command.desc}`).join('\n')}`;

      setMessages(prev => [
        ...prev,
        { role: 'user', content: trimmed },
        { role: 'assistant', content: helpText }
      ]);
      return;
    }

    if (trimmed === '/exit' || trimmed === '/quit' || trimmed === 'exit' || trimmed === 'quit') {
      exit();
      return;
    }

    if (trimmed.startsWith('/provider add ')) {
      const parts = trimmed.slice('/provider add'.length).trim().split(/\s+/);
      const [id, baseUrl, apiKeyEnv, modelToken = '', ...labelParts] = parts;
      if (!id || !baseUrl || !apiKeyEnv) {
        setMessages(prev => [...prev, { role: 'assistant', content:
          'Usage: /provider add <id> <base_url> <api_key_env> [default_model|-] [label...]\n' +
          'Example: /provider add openrouter https://openrouter.ai/api/v1 OPENROUTER_API_KEY - OpenRouter'
        }]);
        return;
      }
      try {
        const provider = addProvider({ id, baseUrl, apiKeyEnv,
          defaultModel: modelToken === '-' ? '' : modelToken,
          label: labelParts.join(' ') || id
        });
        setMessages(prev => [...prev, { role: 'assistant', content:
          'Provider ' + provider.label + ' tersimpan di registry lokal.\n' +
          'API key dibaca dari ' + provider.apiKeyEnv + '. Isi di .env pribadi atau environment; key tidak disimpan di repository.'
        }]);
      } catch (error) {
        setMessages(prev => [...prev, { role: 'assistant', content: 'Gagal menambahkan provider: ' + error.message }]);
      }
      return;
    }

    if (trimmed.startsWith('/provider remove ')) {
      const id = trimmed.slice('/provider remove'.length).trim();
      const removed = removeProvider(id);
      setMessages(prev => [...prev, { role: 'assistant', content: removed
        ? 'Provider ' + id + ' dihapus dari registry lokal.'
        : 'Provider tidak ditemukan atau dikelola oleh environment.'
      }]);
      return;
    }

    if (trimmed === '/provider list') {
      const entries = getProviderCatalog(session?.model);
      setMessages(prev => [...prev, { role: 'assistant', content: entries.length
        ? entries.map(provider => provider.label + ' (' + provider.id + ') — ' +
          (provider.configured ? 'API key ready' : 'missing ' + provider.keyVariable) +
          ' — ' + provider.baseUrl).join('\n')
        : 'Belum ada provider. Gunakan /provider add untuk menambahkan AI router.'
      }]);
      return;
    }

    if (trimmed === '/provider') {
      const activeIndex = providerOptions.findIndex(provider => provider.active);
      setSelectedProviderIndex(activeIndex >= 0 ? activeIndex : 0);
      setProviderPickerOpen(true);
      return;
    }

    if (trimmed === '/plan') {
      try {
        const updated = await client.updateSessionSettings({ mode: 'plan' });
        setSession(current => ({ ...current, ...updated }));
      } catch (err) {
        setMessages(prev => [...prev, { role: 'assistant', content: `Failed to update mode: ${err.message}` }]);
        return;
      }
      setMessages(prev => [
        ...prev,
        { role: 'user', content: trimmed },
        { role: 'assistant', content: '🔒 Mode diubah ke PLAN (Read-only). Tool write_file dan edit_file diblokir otomatis.' }
      ]);
      return;
    }

    if (trimmed === '/build') {
      try {
        const updated = await client.updateSessionSettings({ mode: 'build' });
        setSession(current => ({ ...current, ...updated }));
      } catch (err) {
        setMessages(prev => [...prev, { role: 'assistant', content: `Failed to update mode: ${err.message}` }]);
        return;
      }
      setMessages(prev => [
        ...prev,
        { role: 'user', content: trimmed },
        { role: 'assistant', content: '⚡ Mode diubah ke BUILD (Full execution). Modifikasi file & command diizinkan.' }
      ]);
      return;
    }

    if (trimmed === '/model' || trimmed === '/model list') {
      setAgentStatus({ state: 'thinking', text: 'Discovering models from configured providers...' });
      try {
        const catalog = await listAllModels();
        setModelOptions(catalog.models);
        setSelectedModelIndex(Math.max(0, catalog.models.findIndex(model => model.id === session?.model)));
        if (catalog.models.length) {
          setModelPickerOpen(true);
        } else {
          const errorText = catalog.errors.map(item => item.providerId + ': ' + item.error).join('\n');
          setMessages(prev => [...prev, { role: 'assistant', content:
            'Belum ada model yang berhasil ditemukan. Periksa API key dan endpoint provider.' +
            (errorText ? '\n' + errorText : '')
          }]);
        }
      } catch (error) {
        setMessages(prev => [...prev, { role: 'assistant', content: 'Gagal memuat model: ' + error.message }]);
      } finally {
        setAgentStatus({ state: 'idle', text: '' });
      }
      return;
    }

    if (trimmed.startsWith('/model ')) {
      const newModel = trimmed.slice(7).trim();
      try {
        const updated = await client.updateSessionSettings({ model: newModel });
        setSession(current => ({ ...current, ...updated }));
        setMessages(prev => [...prev, { role: 'assistant', content: 'Model aktif: ' + newModel }]);
      } catch (error) {
        setMessages(prev => [...prev, { role: 'assistant', content: 'Gagal mengganti model: ' + error.message }]);
      }
      return;
    }

    if (trimmed === '/cost' || trimmed === '/usage') {
      try {
        const loaded = await client.loadSession(session.id);
        const config = getModelConfig(session.model);
        const u = loaded.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
        const inCost = ((u.prompt_tokens / 1_000_000) * (config.inputPrice || 0)).toFixed(4);
        const outCost = ((u.completion_tokens / 1_000_000) * (config.outputPrice || 0)).toFixed(4);
        const totalCost = (parseFloat(inCost) + parseFloat(outCost)).toFixed(4);

        const report = `📊 LAPORAN KONSUMSI TOKEN & BIAYA:\nModel: ${config.name || session.model}\n• Prompt Tokens: ${(u.prompt_tokens || 0).toLocaleString()} (rate: $${config.inputPrice || 0}/1M)\n• Comp Tokens:   ${(u.completion_tokens || 0).toLocaleString()} (rate: $${config.outputPrice || 0}/1M)\n• Total Tokens:  ${(u.total_tokens || 0).toLocaleString()}\n• Estimasi Biaya: $${totalCost} USD`;

        setMessages(prev => [
          ...prev,
          { role: 'user', content: trimmed },
          { role: 'assistant', content: report }
        ]);
      } catch (err) {
        setMessages(prev => [...prev, { role: 'user', content: trimmed }, { role: 'assistant', content: `Gagal memuat cost: ${err.message}` }]);
      }
      return;
    }

    if (trimmed === '/compact') {
      try {
        setAgentStatus({ state: 'thinking', text: 'Memangkas konteks percakapan...' });
        const res = await client.compactSession();
        if (res.compacted) {
          setMessages(prev => [
            ...prev,
            { role: 'user', content: trimmed },
            { role: 'assistant', content: `✔ Konteks berhasil dikompak: ${res.beforeTokens.toLocaleString()} -> ${res.afterTokens.toLocaleString()} tokens (menghemat ${res.savedTokens.toLocaleString()} tokens).` }
          ]);
        } else {
          setMessages(prev => [
            ...prev,
            { role: 'user', content: trimmed },
            { role: 'assistant', content: res.message || 'Riwayat konteks masih pendek dan sudah padat.' }
          ]);
        }
      } catch (err) {
        setMessages(prev => [...prev, { role: 'user', content: trimmed }, { role: 'assistant', content: `Gagal memangkas konteks: ${err.message}` }]);
      } finally {
        setAgentStatus({ state: 'idle', text: '' });
      }
      return;
    }

    if (trimmed === '/diff') {
      const diffRes = await snapshotManager.getDiff();
      if (!diffRes.success) {
        setMessages(prev => [...prev, { role: 'user', content: trimmed }, { role: 'assistant', content: `⚠️ ${diffRes.message}` }]);
      } else if (!diffRes.diff && !diffRes.status) {
        setMessages(prev => [...prev, { role: 'user', content: trimmed }, { role: 'assistant', content: '✔ Working directory bersih. Tidak ada perubahan yang belum di-commit.' }]);
      } else {
        const header = `WORKSPACE DIFF (vs ${diffRes.compareRef}):\nStatus:\n${diffRes.status || 'Clean'}\n`;
        const diffBody = diffRes.diff ? diffRes.diff.slice(0, 1500) : '';
        setMessages(prev => [
          ...prev,
          { role: 'user', content: trimmed },
          { role: 'assistant', content: header + (diffBody.length === 1500 ? diffBody + '\n... (dipangkas)' : diffBody) }
        ]);
      }
      return;
    }

    if (trimmed === '/undo') {
      const res = await snapshotManager.undo();
      setMessages(prev => [
        ...prev,
        { role: 'user', content: trimmed },
        { role: 'assistant', content: res.success ? `↩️ [Undo] ${res.message}` : `⚠️ [Undo] ${res.message}` }
      ]);
      return;
    }

    if (trimmed === '/redo') {
      const res = await snapshotManager.redo();
      setMessages(prev => [
        ...prev,
        { role: 'user', content: trimmed },
        { role: 'assistant', content: res.success ? `↪️ [Redo] ${res.message}` : `⚠️ [Redo] ${res.message}` }
      ]);
      return;
    }

    if (trimmed === '/checkpoints') {
      const cps = snapshotManager.listCheckpoints();
      if (cps.length === 0) {
        setMessages(prev => [...prev, { role: 'user', content: trimmed }, { role: 'assistant', content: 'Belum ada checkpoint git dalam sesi ini.' }]);
      } else {
        const table = cps.map(cp => `[${cp.index}] ${cp.ref} "${cp.label}" ${new Date(cp.timestamp).toLocaleTimeString()}${cp.current ? ' ◀ current' : ''}`).join('\n');
        setMessages(prev => [
          ...prev,
          { role: 'user', content: trimmed },
          { role: 'assistant', content: `DAFTAR CHECKPOINT GIT:\n${table}` }
        ]);
      }
      return;
    }

    if (trimmed.startsWith('/checkpoint')) {
      const label = trimmed.slice(11).trim() || undefined;
      const res = await snapshotManager.createCheckpoint(label);
      setMessages(prev => [
        ...prev,
        { role: 'user', content: trimmed },
        { role: 'assistant', content: res.success ? `📌 Checkpoint dibuat: [${res.index}] ${res.ref} "${res.label}"` : `⚠️ ${res.message}` }
      ]);
      return;
    }

    if (trimmed.startsWith('/export')) {
      const outputArg = trimmed.slice(7).trim();
      const outputPath = outputArg || `nexus-session-${session.id}.html`;
      try {
        const sessionData = await client.loadSession(session.id);
        exportSessionToHTML(sessionData, outputPath);
        setMessages(prev => [
          ...prev,
          { role: 'user', content: trimmed },
          { role: 'assistant', content: `📄 Sesi berhasil diekspor ke HTML: ${path.resolve(outputPath)}` }
        ]);
      } catch (err) {
        setMessages(prev => [...prev, { role: 'user', content: trimmed }, { role: 'assistant', content: `Gagal mengekspor sesi: ${err.message}` }]);
      }
      return;
    }

    if (trimmed === '/doctor') {
      const isGit = await isGitRepo(process.cwd());
      const hasDocker = await isDockerAvailable();
      const hasKey = Boolean(process.env.API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY);
      let subagents = 0;
      try {
        const d = path.resolve(process.cwd(), '.agent', 'agents');
        if (fs.existsSync(d)) subagents = fs.readdirSync(d).filter(f => f.endsWith('.md')).length;
      } catch {}

      const report = `🏥 HASIL DIAGNOSTIK NEXUS:\n• Node.js:        ${process.version} (>=20.0.0 required)\n• Git Repo:       ${isGit ? 'Terdeteksi' : 'Bukan repo git'}\n• Docker Sandbox: ${hasDocker ? 'Aktif' : 'Tidak terdeteksi (fallback ke exec lokal)'}\n• Model Aktif:    ${session.model || 'default'}\n• API Key:        ${hasKey ? 'Terkonfigurasi di environment' : 'Belum diatur di .env'}\n• Registered Tools: ${defaultRegistry.list().length} tools\n• Custom Agents:  ${subagents} subagent`;

      setMessages(prev => [
        ...prev,
        { role: 'user', content: trimmed },
        { role: 'assistant', content: report }
      ]);
      return;
    }

    if (trimmed === '/init') {
      try {
        const dirs = [
          path.resolve(process.cwd(), '.agent', 'agents'),
          path.resolve(process.cwd(), '.agent', 'commands'),
          path.resolve(process.cwd(), '.agent', 'plugins'),
          path.resolve(process.cwd(), '.agent', 'sessions')
        ];
        for (const dir of dirs) fs.mkdirSync(dir, { recursive: true });
        setMessages(prev => [
          ...prev,
          { role: 'user', content: trimmed },
          { role: 'assistant', content: '✔ Workspace berhasil diinisialisasi untuk Nexus Agent (.agent/{agents, commands, plugins, sessions}).' }
        ]);
      } catch (err) {
        setMessages(prev => [...prev, { role: 'user', content: trimmed }, { role: 'assistant', content: `Gagal inisialisasi: ${err.message}` }]);
      }
      return;
    }

    if (trimmed === '/sessions') {
      try {
        const list = await client.listSessions();
        const formatted = list.map(s => `- ${s.id}${s.id === session.id ? ' (active)' : ''} | [${s.mode}] ${s.model || 'default'} | ${s.messageCount} msgs | ${(s.tokens || 0).toLocaleString()} tok`).join('\n');
        setMessages(prev => [
          ...prev,
          { role: 'user', content: trimmed },
          { role: 'assistant', content: `SESI TERSIMPAN:\n${formatted || '(belum ada sesi lain)'}` }
        ]);
      } catch (err) {
        setMessages(prev => [...prev, { role: 'user', content: trimmed }, { role: 'assistant', content: `Gagal memuat sesi: ${err.message}` }]);
      }
      return;
    }

    if (trimmed.startsWith('/resume')) {
      const targetId = trimmed.slice(7).trim();
      if (!targetId) {
        setMessages(prev => [...prev, { role: 'user', content: trimmed }, { role: 'assistant', content: 'Format: /resume <session_id>' }]);
      } else {
        try {
          const resumed = await client.loadSession(targetId);
          setSession(resumed);
          setMessages(prev => [
            ...prev,
            { role: 'user', content: trimmed },
            { role: 'assistant', content: `📂 Sesi berhasil dialihkan ke: ${resumed.id} (${resumed.messages?.length || 0} pesan).` }
          ]);
        } catch (err) {
          setMessages(prev => [...prev, { role: 'user', content: trimmed }, { role: 'assistant', content: `Gagal resume: ${err.message}` }]);
        }
      }
      return;
    }

    if (trimmed === '/new') {
      try {
        const fresh = await client.createSession({ mode: 'build', model: session.model });
        setSession(fresh);
        setMessages([
          { role: 'assistant', content: `✨ Sesi baru berhasil diinisialisasi: ${fresh.id}` }
        ]);
        setTokenUsage(0);
        setAgentStatus({ state: 'idle', text: '' });
      } catch (err) {
        setMessages(prev => [...prev, { role: 'assistant', content: `Gagal membuat sesi: ${err.message}` }]);
      }
      return;
    }

    if (trimmed === '/clear') {
      setMessages([]);
      setActiveStream('');
      return;
    }

    if (trimmed === '/abort') {
      await client.abortSession();
      setAgentStatus({ state: 'done', text: 'Proses agen berhasil dibatalkan.' });
      setTimeout(() => {
        setAgentStatus({ state: 'idle', text: '' });
      }, 2500);
      return;
    }

    // ─── LLM Turn Execution ───────────────────────────────────────────────

    setMessages(prev => [...prev, { role: 'user', content: trimmed }]);
    setActiveStream('');
    setElapsedSeconds(0);
    setAgentStatus({ state: 'thinking', text: 'Menghubungi LLM...', step: 1 });

    let currentTokens = '';
    try {
      await client.sendMessage(trimmed, {
        onToken: (tok) => {
          currentTokens += tok;
          setActiveStream(currentTokens);
          setAgentStatus(prev => ({ ...prev, state: 'thinking', text: 'Menerima jawaban streaming dari LLM...' }));
        },
        onToolStart: (event) => {
          if (currentTokens) {
            setMessages(prev => [...prev, { role: 'assistant', content: currentTokens }]);
            currentTokens = '';
            setActiveStream('');
          }
          setMessages(prev => [...prev, { role: 'tool_call', name: event.name, args: event.args }]);
          setAgentStatus({
            state: 'tool',
            toolName: event.name,
            text: `Mengeksekusi tool [${event.name}]...`,
            step: event.step
          });
        },
        onToolResult: (event) => {
          setMessages(prev => [...prev, { role: 'tool_result', name: event.name, output: event.output }]);
          setAgentStatus({
            state: 'thinking',
            text: `Tool [${event.name}] selesai. Mengevaluasi hasil eksekusi...`,
            step: event.step
          });
        },
        onPermission: (permReq) => {
          setPendingPermission(permReq);
          setAgentStatus({
            state: 'permission',
            text: `Izin diperlukan untuk mengeksekusi tool [${permReq.tool}]`,
            step: permReq.step
          });
        },
        onDone: (doneData) => {
          if (currentTokens) {
            setMessages(prev => [...prev, { role: 'assistant', content: currentTokens }]);
            currentTokens = '';
            setActiveStream('');
          }
          if (doneData.usage) {
            const u = doneData.usage;
            setTokenUsage(u.total_tokens || u.total || 0);
          }
          setAgentStatus({
            state: 'done',
            text: `Selesai dalam ${doneData.steps || 1} langkah.`
          });
          setTimeout(() => {
            setAgentStatus({ state: 'idle', text: '' });
          }, 3500);
        },
        onError: (errData) => {
          setAgentStatus({ state: 'error', text: errData.message || 'Error eksekusi.' });
          setMessages(prev => [...prev, { role: 'assistant', content: `❌ Error: ${errData.message}` }]);
          setTimeout(() => {
            setAgentStatus({ state: 'idle', text: '' });
          }, 4000);
        }
      });
    } catch (err) {
      setAgentStatus({ state: 'error', text: err.message });
      setMessages(prev => [...prev, { role: 'assistant', content: `❌ Error: ${err.message}` }]);
      setTimeout(() => {
        setAgentStatus({ state: 'idle', text: '' });
      }, 4000);
    }
  };

  // Keyboard input via Ink useInput
  useInput((inputChar, key) => {
    // If pending permission modal is active
    if (pendingPermission) {
      if (inputChar.toLowerCase() === 'y') {
        client.answerPermission(pendingPermission.id, true);
        setPendingPermission(null);
        setAgentStatus({ state: 'tool', text: `Izin diberikan untuk ${pendingPermission.tool}` });
      } else if (inputChar.toLowerCase() === 'n') {
        client.answerPermission(pendingPermission.id, false);
        setPendingPermission(null);
        setAgentStatus({ state: 'thinking', text: `Izin ditolak untuk ${pendingPermission.tool}` });
      }
      return;
    }

    // Model picker keyboard navigation.
    if (modelPickerOpen) {
      if (key.escape) { setModelPickerOpen(false); return; }
      if (key.upArrow) { setSelectedModelIndex(index => Math.max(0, index - 1)); return; }
      if (key.downArrow) { setSelectedModelIndex(index => Math.min(modelOptions.length - 1, index + 1)); return; }
      if (key.return) {
        const model = modelOptions[selectedModelIndex];
        if (!model) return;
        client.updateSessionSettings({ model: model.id }).then(updated => {
          setSession(current => ({ ...current, ...updated }));
          setMessages(prev => [...prev, { role: 'assistant', content: 'Model aktif: ' + model.id }]);
        }).catch(error => {
          setMessages(prev => [...prev, { role: 'assistant', content: 'Gagal mengganti model: ' + error.message }]);
        });
        setModelPickerOpen(false);
        setInput('');
        return;
      }
      return;
    }

    // Provider picker keyboard navigation.
    if (providerPickerOpen) {
      if (key.escape) { setProviderPickerOpen(false); return; }
      const providerCount = providerOptions.length + 1;
      if (key.upArrow) { setSelectedProviderIndex(index => Math.max(0, index - 1)); return; }
      if (key.downArrow) { setSelectedProviderIndex(index => Math.min(providerCount - 1, index + 1)); return; }
      if (key.return) {
        if (selectedProviderIndex === providerOptions.length) {
          setProviderPickerOpen(false);
          setMessages(prev => [...prev, { role: 'assistant', content:
            'Tambahkan provider dengan:\n/provider add <id> <base_url> <api_key_env> [default_model|-] [label...]\n' +
            'Contoh: /provider add openrouter https://openrouter.ai/api/v1 OPENROUTER_API_KEY - OpenRouter'
          }]);
          return;
        }
        const provider = providerOptions[selectedProviderIndex];
        if (!provider) return;
        if (!provider.configured) {
          setMessages(prev => [...prev, { role: 'assistant', content:
            'API key belum ditemukan. Set ' + provider.keyVariable + ' pada environment pribadi, lalu coba lagi.'
          }]);
          return;
        }
        setAgentStatus({ state: 'thinking', text: 'Loading provider models...' });
        listProviderModels(provider.id).then(models => {
          if (models.length) {
            setModelOptions(models);
            setSelectedModelIndex(Math.max(0, models.findIndex(model => model.id === session?.model)));
            setModelPickerOpen(true);
          } else if (provider.defaultModel) {
            const selectedModel = provider.id + '/' + provider.defaultModel;
            return client.updateSessionSettings({ model: selectedModel }).then(updated => {
              setSession(current => ({ ...current, ...updated }));
              setMessages(prev => [...prev, { role: 'assistant', content: 'Provider aktif: ' + selectedModel }]);
            });
          } else {
            setMessages(prev => [...prev, { role: 'assistant', content:
              'Endpoint ' + provider.baseUrl + ' tidak mengembalikan model.'
            }]);
          }
        }).catch(error => {
          setMessages(prev => [...prev, { role: 'assistant', content: 'Gagal memuat model: ' + error.message }]);
        }).finally(() => setAgentStatus({ state: 'idle', text: '' }));
        setProviderPickerOpen(false);
        return;
      }
      return;
    }

    // Interactive command palette navigation when typing /
    if (isSlashActive && filteredCommands.length > 0) {
      // Escape: dismiss palette
      if (key.escape) {
        setInput('');
        return;
      }

      // Up Arrow
      if (key.upArrow) {
        const prevIdx = selectedCmdIndex > 0 ? selectedCmdIndex - 1 : filteredCommands.length - 1;
        setSelectedCmdIndex(prevIdx);
        if (prevIdx === filteredCommands.length - 1) {
          // Wrapped to bottom
          setScrollOffset(Math.max(0, filteredCommands.length - commandPageSize));
        } else if (prevIdx < scrollOffset) {
          setScrollOffset(prevIdx);
        }
        return;
      }

      // Down Arrow
      if (key.downArrow) {
        const nextIdx = selectedCmdIndex < filteredCommands.length - 1 ? selectedCmdIndex + 1 : 0;
        setSelectedCmdIndex(nextIdx);
        if (nextIdx === 0) {
          // Wrapped to top
          setScrollOffset(0);
        } else if (nextIdx >= scrollOffset + commandPageSize) {
          setScrollOffset(nextIdx - PAGE_SIZE + 1);
        }
        return;
      }

      // Tab: autocomplete
      if (key.tab) {
        const chosen = filteredCommands[selectedCmdIndex];
        if (chosen) {
          setInput(chosen.cmd + (chosen.needsArg ? ' ' : ''));
        }
        return;
      }

      // A bare slash opens help; it must not accidentally select the first command.
      if (key.return && input.trim() === '/') {
        setInput('');
        handleExecute('/');
        return;
      }

      // Return / Enter
      if (key.return) {
        const chosen = filteredCommands[selectedCmdIndex];
        if (chosen) {
          if (!chosen.needsArg) {
            setInput('');
            handleExecute(chosen.cmd);
            return;
          } else {
            setInput(chosen.cmd + ' ');
            return;
          }
        }
      }
    }

    if (key.return) {
      if (input.trim() === 'exit' || input.trim() === 'quit') {
        exit();
        return;
      }
      const sent = input;
      setInput('');
      handleExecute(sent);
    } else if (key.backspace || key.delete) {
      setInput(prev => prev.slice(0, -1));
    } else if (inputChar) {
      setInput(prev => prev + inputChar);
    }
  }, { isActive: isRawModeSupported });

  // Readline fallback when stdin is piped / non-TTY
  const handleExecuteRef = useRef();
  handleExecuteRef.current = handleExecute;
  const pendingPermissionRef = useRef();
  pendingPermissionRef.current = pendingPermission;

  useEffect(() => {
    if (isRawModeSupported) return;
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (trimmed === 'exit' || trimmed === 'quit') {
        exit();
        return;
      }
      if (pendingPermissionRef.current) {
        const allow = trimmed.toLowerCase() === 'y';
        client.answerPermission(pendingPermissionRef.current.id, allow);
        setPendingPermission(null);
        return;
      }
      handleExecuteRef.current?.(trimmed);
    });
    return () => rl.close();
  }, [isRawModeSupported]);

  return createElement(Box, { flexDirection: 'column', width: '100%' },
    createElement(NexusCompactHeader, { session, agentStatus, tokenUsage, frameIndex: spinnerFrame, elapsedSeconds, gitBranch }),
    createElement(PermissionModal, { request: pendingPermission }),
    createElement(MessagesArea, { messages, activeStream, maxRows: maxMessageRows }),
    isSlashActive && filteredCommands.length > 0
      ? createElement(CommandPalette, {
          commands: filteredCommands,
          selectedIndex: selectedCmdIndex,
          scrollOffset,
          pageSize: commandPageSize
        })
      : null,
    providerPickerOpen
      ? createElement(ProviderPalette, { providers: providerOptions, selectedIndex: selectedProviderIndex })
      : null,
    modelPickerOpen
      ? createElement(ModelPalette, { models: modelOptions, selectedIndex: selectedModelIndex })
      : null,
    createElement(InputBox, { input, mode: session?.mode || 'build', isBusy }),
    createElement(FooterBar)
  );
}

// ─── Entry Point & Auto Server Launcher ────────────────────────────────────────

async function startTUI() {
  let localServer = null;
  let serverUrl = process.env.NEXUS_SERVER_URL;
  const token = process.env.NEXUS_SERVER_TOKEN || null;
  const snapshotManager = new SessionSnapshotManager(process.cwd());

  if (!serverUrl) {
    try {
      const checkRes = await fetch('http://127.0.0.1:4141/session');
      if (checkRes.ok) {
        serverUrl = 'http://127.0.0.1:4141';
      }
    } catch {}

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
  }

  const client = new TUIClient({ serverUrl, token });
  const initialModel = process.env.MODEL || '';
  const initialMode = 'build';

  await client.createSession({ mode: initialMode, model: initialModel });
  await snapshotManager.captureFirstSnapshot();

  const { waitUntilExit } = render(
    createElement(NexusTUIApp, { client, snapshotManager })
  );

  await waitUntilExit();

  if (localServer) {
    try { await localServer.close(); } catch {}
  }
  process.exit(0);
}

startTUI().catch(err => {
  console.error('Fatal TUI Error:', err);
  process.exit(1);
});
