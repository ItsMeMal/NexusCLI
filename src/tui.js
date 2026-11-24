import React, { useState, useEffect, useRef } from 'react';
import { render, Box, Text, Spacer, Newline, useInput, useApp, useStdin, useWindowSize } from 'ink';
import readline from 'node:readline';
import { createNexusServer } from './server.js';
import { loadEnv } from './core/config.js';
import { SessionSnapshotManager } from './core/snapshot.js';

const createElement = React.createElement;

// Load environment variables (.env)
loadEnv();

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const MASCOT_FRAMES = {
  idle: [
    {
      face: [' ∧,,∧  ', '( ˘ᴗ˘ ) ', 'c( つ🪄*'],
      color: 'magenta',
      quote: 'Siap membantumu coding. Ketik instruksi atau /help~'
    },
    {
      face: [' ∧,,∧  ', '( ˘‿˘ ) ', 'c( つ🪄✨'],
      color: 'magenta',
      quote: 'Punya ide fitur atau bug? Tulis instruksi di bawah~'
    }
  ],
  thinking: [
    {
      face: [' ∧,,∧  ', '( ✧ω✧) ', 'c( つ🪄✦'],
      color: 'yellow',
      quote: 'Menganalisis workspace & merapal solusi... ✦'
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

// ─── Mascot & Hero Component ──────────────────────────────────────────────────

function ElainaMascotHero({ session, agentStatus, tokenUsage, frameIndex, elapsedSeconds }) {
  const mode = session?.mode || 'build';
  const model = session?.model || 'Elaina-Free';
  const stateKey = MASCOT_FRAMES[agentStatus.state] ? agentStatus.state : 'idle';
  const frames = MASCOT_FRAMES[stateKey];
  const currentFrame = frames[frameIndex % frames.length];

  const stepInfo = agentStatus.step ? ` Step ${agentStatus.step}/25` : '';
  const timeInfo = elapsedSeconds > 0 ? ` (${elapsedSeconds}s)` : '';
  const spinnerChar = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length];

  let statusBadge = '● IDLE';
  if (agentStatus.state === 'thinking') statusBadge = `${spinnerChar} THINKING${stepInfo}${timeInfo}`;
  if (agentStatus.state === 'tool') statusBadge = `⚡ TOOL [${agentStatus.toolName || 'exec'}]${stepInfo}${timeInfo}`;
  if (agentStatus.state === 'permission') statusBadge = `🛑 SECURITY GATE${stepInfo}`;
  if (agentStatus.state === 'done') statusBadge = '✔ COMPLETED';
  if (agentStatus.state === 'error') statusBadge = '✕ ERROR';

  const dialogue = agentStatus.text || currentFrame.quote;
  const rawId = session?.id || '';
  const shortId = rawId ? (rawId.length > 20 ? rawId.slice(0, 18) + '…' : rawId) : 'none';

  return createElement(Box, {
    flexDirection: 'row',
    borderStyle: 'round',
    borderColor: currentFrame.color,
    paddingX: 1,
    marginY: 0
  },
    // Left: Animated Mascot ASCII
    createElement(Box, { flexDirection: 'column', marginRight: 2 },
      createElement(Text, { color: currentFrame.color, bold: true }, currentFrame.face[0]),
      createElement(Text, { color: 'white' }, currentFrame.face[1]),
      createElement(Text, { color: currentFrame.color }, currentFrame.face[2])
    ),
    // Right: Status + Dialogue + Session Info
    createElement(Box, { flexDirection: 'column', flexGrow: 1 },
      createElement(Box, { flexDirection: 'row' },
        createElement(Text, { color: currentFrame.color, bold: true }, '✦ ELAINA • NEXUS AI '),
        createElement(Text, { color: currentFrame.color, bold: true }, `[${statusBadge}]`),
        createElement(Spacer),
        createElement(Box, { paddingX: 1 },
          createElement(Text, {
            color: 'black',
            backgroundColor: mode === 'plan' ? 'yellow' : 'green',
            bold: true
          }, ` ${mode.toUpperCase()} `)
        ),
        createElement(Text, { color: 'magenta', bold: true }, `[${model}]`),
        createElement(Text, { color: 'gray' }, ` ${(tokenUsage || 0).toLocaleString()} tok`)
      ),
      createElement(Text, { color: 'white' }, `"${dialogue}"`),
      createElement(Text, { color: 'gray', dimColor: true },
        `Session: ${shortId} │ /help untuk panduan`
      )
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
    minHeight: 4
  },
    recentMessages.length === 0 && !activeStream
      ? createElement(Box, { paddingY: 0 },
          createElement(Text, { color: 'gray', dimColor: true }, 'Belum ada percakapan. Tulis instruksi coding atau perintah slash di bawah.')
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
        const preview = (msg.output || '').length > 100
          ? (msg.output || '').slice(0, 100).replace(/\r?\n/g, ' ') + '…'
          : (msg.output || '').replace(/\r?\n/g, ' ');
        return createElement(Box, { key: idx, paddingLeft: 2, marginY: 0 },
          createElement(Text, { color: 'green', dimColor: true }, `└─ Result: ${preview}`)
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

function InputBox({ input, mode, isBusy }) {
  return createElement(Box, {
    borderStyle: 'round',
    borderColor: isBusy ? 'yellow' : 'cyan',
    paddingX: 1,
    marginY: 0
  },
    createElement(Text, { color: 'cyan', bold: true }, `[${mode.toUpperCase()}] ❯ `),
    createElement(Text, { color: isBusy ? 'gray' : 'white' },
      input || (isBusy ? 'Elaina sedang memproses... tunggu sejenak' : 'Ketik instruksi coding atau perintah slash (/help)...')
    ),
    !isBusy ? createElement(Text, { color: 'cyan' }, '█') : null
  );
}

function FooterBar() {
  return createElement(Box, { paddingX: 1, marginTop: 0 },
    createElement(Text, { color: 'gray', dimColor: true },
      'Perintah cepat: /plan  /build  /new  /undo  /clear  /abort  /help  exit'
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
  const [tokenUsage, setTokenUsage] = useState(0);
  const [pendingPermission, setPendingPermission] = useState(null);
  const [agentStatus, setAgentStatus] = useState({ state: 'idle', text: '' });
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const isBusy = agentStatus.state === 'thinking' || agentStatus.state === 'tool' || agentStatus.state === 'permission';

  // Dynamic max message rows based on terminal height
  const maxMessageRows = Math.max(2, Math.min(8, (rows || 24) - 15));

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

  // Execute User Turn
  const handleExecute = async (userPrompt) => {
    if (isBusy) return;
    const trimmed = userPrompt.trim();
    if (!trimmed) return;

    // Slash command handling
    if (trimmed === '/help') {
      setMessages(prev => [
        ...prev,
        { role: 'user', content: trimmed },
        { role: 'assistant', content: 'Perintah yang tersedia:\n• /plan: Berpindah ke mode PLAN (read-only, blokir mutasi)\n• /build: Berpindah ke mode BUILD (eksekusi penuh & verifikasi)\n• /new: Mulai sesi kerja baru\n• /undo: Revert git snapshot ke awal sesi\n• /clear: Bersihkan riwayat chat tampilan\n• /abort: Batalkan proses aktif yang sedang berjalan\n• exit / quit: Keluar dari TUI' }
      ]);
      return;
    }

    if (trimmed === '/plan') {
      setSession(s => ({ ...s, mode: 'plan' }));
      client.sessionData.mode = 'plan';
      setMessages(prev => [
        ...prev,
        { role: 'user', content: trimmed },
        { role: 'assistant', content: '🔒 Mode diubah ke PLAN (Read-only). Tool write_file dan edit_file diblokir otomatis.' }
      ]);
      return;
    }

    if (trimmed === '/build') {
      setSession(s => ({ ...s, mode: 'build' }));
      client.sessionData.mode = 'build';
      setMessages(prev => [
        ...prev,
        { role: 'user', content: trimmed },
        { role: 'assistant', content: '⚡ Mode diubah ke BUILD (Full execution). Modifikasi file & command diizinkan.' }
      ]);
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

    if (trimmed === '/undo') {
      const res = await snapshotManager.restore();
      setMessages(prev => [
        ...prev,
        { role: 'user', content: trimmed },
        { role: 'assistant', content: `↩️ [Undo] ${res.message}` }
      ]);
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

    // Add user message to UI
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

  // Keyboard input via Ink useInput when raw mode TTY is available
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
    createElement(ElainaMascotHero, { session, agentStatus, tokenUsage, frameIndex: spinnerFrame, elapsedSeconds }),
    createElement(PermissionModal, { request: pendingPermission }),
    createElement(MessagesArea, { messages, activeStream, maxRows: maxMessageRows }),
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
    // Check if port 4141 is already running a Nexus server
    try {
      const ping = await fetch('http://127.0.0.1:4141/session', {
        headers: token ? { 'Authorization': `Bearer ${token}` } : {}
      });
      if (ping.ok || ping.status === 401) {
        serverUrl = 'http://127.0.0.1:4141';
      }
    } catch {
      // Not running, spawn in-process server
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
  const initialModel = process.env.MODEL || 'Elaina-Free';
  await client.createSession({ mode: 'build', model: initialModel });

  const { waitUntilExit } = render(
    createElement(NexusTUIApp, { client, snapshotManager })
  );

  await waitUntilExit();

  if (localServer) {
    await localServer.close();
  }
}

startTUI().catch(err => {
  console.error('Fatal TUI Error:', err);
  process.exit(1);
});
