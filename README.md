# Nexus Coding Agent CLI

Coding agent berbasis terminal mirip OpenCode yang dibangun dari nol menggunakan Node.js (ESM). LLM memanggil tools (`read_file`, `write_file`, `edit_file`, `bash`, `grep`, `glob`, `todo`, `webfetch`, `repo_map`, `task`) dalam agent loop sampai tugas selesai.

Arsitektur: **Core + Server (HTTP/SSE) + Multi-Client (CLI/TUI)**.

---

## Fitur Utama

- **10 Core Tools**: `read_file`, `write_file`, `edit_file`, `bash`, `grep` (ripgrep fallback), `glob`, `todo`, `webfetch`, `repo_map`, `task`.
- **Client/Server Architecture**: REST API + Server-Sent Events (SSE) streaming.
- **Provider Abstraction**: OpenAI-compatible, Anthropic, Gemini dengan interface seragam (`provider/model`).
- **Context Management**: Token estimation, auto-compaction saat >80% batas model, output pruning.
- **Security & Hardening**:
  - Sandboxing: Docker mount read-write `/workspace` tanpa network (jika tersedia).
  - Secret Redaction: Meredaksi token/API key/[.env] di output dan log.
  - Prompt Injection Mitigation: Menandai konten eksternal sebagai data tidak tepercaya, mewajibkan konfirmasi untuk tool berbahaya setelah membaca data eksternal.
  - Audit Log: Semua tool call dicatat ke `.agent/audit.log` (JSON Lines).
  - Git snapshot capture & `/undo`/`/redo` checkpoint stack.
- **Mode Non-Interaktif (CI-Ready)**: `nexus run "prompt" --json` dengan structured output dan exit code.
- **Share Sesi**: Ekspor percakapan ke HTML mandiri via `/export [path]` atau `exportSessionToHTML()`.
- **VS Code Extension**: Ekstensi minimal di `extensions/vscode/` untuk mengirim prompt/review langsung dari editor.
- **Extensibility**:
  - **Custom Subagents**: `.agent/agents/*.md` (frontmatter: tools, permission, model + system prompt).
  - **MCP Client**: Stdio & HTTP/SSE via `@modelcontextprotocol/sdk`, konfigurasi di `.agent/mcp.json`.
  - **Plugins**: `.agent/plugins/*.js` (tool registration & hooks: `before_tool`, `after_tool`, `on_message`).
  - **Slash Commands**: `.agent/commands/*.md` dengan template `$ARGUMENTS`.

---

## Struktur Direktori

```
NexusCLI/
├── .agent/
│   ├── agents/            # Definisi custom subagent (*.md)
│   ├── commands/          # Custom slash commands (*.md)
│   ├── plugins/           # JS plugin extensions (*.js)
│   ├── sessions/          # Riwayat sesi JSON
│   ├── audit.log          # Audit log eksekusi tool
│   └── mcp.json           # Konfigurasi MCP server
├── agent.config.json      # Permission policy (allow/ask/deny & bash rules)
├── schemas/
│   └── agent.config.schema.json # JSON Schema untuk editor autocomplete
├── src/
│   ├── cli.js             # Terminal CLI client
│   ├── server.js          # HTTP/SSE server
│   ├── tui.js             # Ink/React TUI client
│   ├── core/
│   │   ├── agent.js       # Agent markdown loader
│   │   ├── audit.js       # Audit logger
│   │   ├── command.js     # Slash command manager
│   │   ├── config.js      # Environment & server config
│   │   ├── context.js     # Context compaction & token accounting
│   │   ├── extensions.js  # Extensions orchestrator
│   │   ├── injection.js   # Prompt injection defense
│   │   ├── llm.js         # LLM client & provider dispatcher
│   │   ├── logger.js      # Structured logger (pino)
│   │   ├── loop.js        # Main agent loop (max 25 steps, loop detection)
│   │   ├── mcp.js         # MCP client manager
│   │   ├── permission.js  # PermissionManager (allow/ask/deny)
│   │   ├── plugin.js      # Plugin manager & hooks
│   │   ├── prompt.js      # System prompt generator
│   │   ├── sandbox.js     # Docker sandbox & bash execution
│   │   ├── secrets.js     # Secret redaction
│   │   ├── session.js     # Session manager & persistence
│   │   └── snapshot.js    # Git snapshot & /undo
│   └── tools/             # Tool implementations
├── test/                  # Test suite (node:test)
├── evals/                 # 10 deterministic engineering evaluation tasks
├── examples/              # Contoh MCP server & extension
├── AGENTS.md              # Project instructions & guidelines
└── package.json
```

---

## Instalasi

### Dari NPM / Tarball Lokal

```bash
# Clone dan install dependensi
git clone <repo-url>
cd NexusCLI
npm install

# Test suite
npm test

# Evaluasi baseline
npm run eval
```

### Global Install

```bash
npm pack
npm install -g nexus-cli-0.1.0.tgz

# Jalankan
nexus
```

---

## Konfigurasi

Buat file `.env` di root project:

```env
# Provider Default (OpenAI Compatible)
BASE_URL=https://api.openai.com/v1
API_KEY=sk-...
MODEL=gpt-4o

# Anthropic (Opsional)
ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-3-5-sonnet-20241022

# Gemini (Opsional)
GEMINI_API_KEY=AIzaSy...
GEMINI_MODEL=gemini-1.5-flash

# Logging & Debug
LOG_LEVEL=info
DEBUG=0
```

### Format Model `provider/model`

Dapat mengganti model saat runtime:
```
/model anthropic/claude-3-5-sonnet-20241022
/model gemini/gemini-1.5-flash
/model openai-compatible/gpt-4o
```

---

## Cara Menulis Custom Agent

Buat file `.agent/agents/<nama>.md`:

```markdown
---
description: Read-only codebase explorer
model: gpt-4o-mini
tools: read_file, grep, glob, repo_map
permission: read-only
---
You are an exploration subagent. Search the codebase and return a concise summary.
Do not modify any files.
```

Subagent dipanggil oleh agent utama melalui tool `task`:
```json
{"agent": "explore", "prompt": "Cari semua penggunaan fungsi X"}
```

Atau paralel:
```json
{"tasks": [
  {"agent": "explore", "prompt": "Cari penggunaan foo"},
  {"agent": "explore", "prompt": "Cari penggunaan bar"}
]}
```

---

## Cara Menulis Plugin

Buat file `.agent/plugins/<nama>.js`:

```javascript
export default function myPlugin({ registry, hooks, workingDir, registerTool }) {
  // 1. Daftarkan custom tool
  registerTool({
    name: 'custom_ping',
    description: 'Ping test tool',
    parameters: {
      type: 'object',
      properties: { host: { type: 'string' } }
    },
    async execute({ host }) {
      return `Pong: ${host}`;
    }
  });

  // 2. Tambah hook
  hooks.before_tool.push(async ({ tool, args }) => {
    console.log(`[myPlugin] Calling ${tool}`);
  });
}
```

---

## Cara Menulis Custom Slash Command

Buat file `.agent/commands/<command>.md`:

Contoh `.agent/commands/review.md`:
```markdown
Review code berikut untuk standar kualitas dan bug: $ARGUMENTS
Berikan checklist ringkas perbaikan jika ada.
```

Di CLI, panggil dengan:
```
/review src/core/loop.js
```

---

## Menghubungkan MCP Server

Edit `.agent/mcp.json`:

```json
{
  "servers": [
    {
      "name": "filesystem",
      "command": "node",
      "args": ["examples/mcp-filesystem-server.mjs", "."]
    }
  ]
}
```

Tool MCP otomatis masuk ke registry dengan prefix `<server>__<tool>`.

---

## Mode Non-Interaktif (CI / Automation)

Untuk integrasi ke CI/CD (GitHub Actions, script):

```bash
# Output teks biasa
nexus run "Tulis fungsi fibonacci di fib.js" --approve

# Output JSON terstruktur ke stdout (exit code 0 jika sukses, 1 jika gagal)
nexus run "Review src/cli.js" --json --mode plan > review.json
```

Format output JSON:
```json
{
  "sessionId": "ses_...",
  "model": "Elaina-Free",
  "mode": "plan",
  "prompt": "Review src/cli.js",
  "response": "Hasil review dari model...",
  "toolCalls": [{ "name": "read_file", "args": {...}, "output": "..." }],
  "error": null,
  "exitCode": 0,
  "usage": { "prompt_tokens": 120, "completion_tokens": 45, "total_tokens": 165 }
}
```

Lihat contoh workflow lengkap di [`.github/workflows/agent-review.yml`](.github/workflows/agent-review.yml).

---

## Share Sesi ke HTML

Di dalam sesi interaktif:
```
/export
# Menghasilkan nexus-session-<id>.html yang siap dibuka di browser
```

Atau tentukan file output:
```
/export docs/session-review.html
```

---

## Undo / Redo Berbasis Git

Nexus membuat checkpoint setiap kali ada perubahan di mode `build`:
- `/undo` — mundur satu checkpoint
- `/redo` — maju satu checkpoint (jika belum ada branch baru)
- `/checkpoints` — daftar seluruh checkpoint yang tersedia
- `/checkpoint [label]` — buat checkpoint manual bernama

---

## Mode Operasi

- `/plan`: Mode read-only. File modification (`write_file`, `edit_file`, destructive `bash`) diblokir.
- `/build`: Mode eksekusi penuh.
- `/undo`: Mengembalikan workspace ke kondisi snapshot git awal sesi.

---

## Lisensi

MIT