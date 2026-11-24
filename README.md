# NEXUSCODE

NexusCode adalah AI orchestrator berbasis terminal yang mengoordinasikan model, tools, MCP servers, plugins, dan specialist agents untuk menyelesaikan pekerjaan lintas domain.

Arsitektur: **Core + Server (HTTP/SSE) + Multi-Client (CLI/TUI)**.

---

## Fitur Utama

- **Orchestration Core**: Memahami tujuan, memecah pekerjaan kompleks, mendelegasikan workstream independen ke specialist agents, menjalankan tools, lalu mengintegrasikan dan memverifikasi hasil.
- **General-Purpose**: Bukan coding-only. Dapat menangani riset, penulisan, analisis, perencanaan, troubleshooting, otomasi, data, dan rekayasa software.

- **10 Core Tools**: `read_file`, `write_file`, `edit_file`, `bash`, `grep` (ripgrep fallback), `glob`, `todo`, `webfetch`, `repo_map`, `task`.
- **Client/Server Architecture**: REST API + Server-Sent Events (SSE) streaming.
- **Provider & Model Picker**: Katalog provider yang bisa dicari, status koneksi, koneksi API key dengan input tersembunyi, dan daftar model yang dikelompokkan per provider. Mendukung OpenAI-compatible gateways/routers, Anthropic, dan Gemini. Metadata provider disimpan di `~/.nexuscli/providers.json`, sedangkan credential lokal dipisah ke `~/.nexuscli/auth.json` dengan permission terbatas; environment variable tetap didukung.
- **Context Management**: Token estimation, auto-compaction saat >80% batas model, output pruning.
- **Security & Hardening**:
  - Sandboxing: Docker mount read-write `/workspace` tanpa network (jika tersedia).
  - Secret Redaction: Meredaksi token/API key/[.env] di output dan log.
  - Prompt Injection Mitigation: Menandai konten eksternal sebagai data tidak tepercaya, mewajibkan konfirmasi untuk tool berbahaya setelah membaca data eksternal.
  - Audit Log: Semua tool call dicatat ke `.agent/audit.log` (JSON Lines).
  - Git snapshot capture & `/undo`/`/redo` checkpoint stack.
- **Mode Non-Interaktif (CI-Ready)**: `nexuscode run "prompt" --json` dengan structured output dan exit code.
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
NexusCode/
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

### Install dari source

```bash
git clone https://github.com/ItsMeMal/NexusCode.git
cd NexusCode
npm ci

# Jalankan dari source
npm start
```

### Install dari npm

Setelah paket dipublikasikan sebagai package publik:

```bash
npm install -g @mallssz/nexuscode-cli

# Jalankan dari direktori mana pun
nexuscode
```

Tanpa instalasi global:

```bash
npm exec --package=@mallssz/nexuscode-cli -- nexuscode
```

Untuk pengembangan lokal, jalankan `npm link` dari root repository agar command `nexuscode` mengarah ke checkout ini.

---

## Konfigurasi

Buat file `.env` di root project:

```env
# Example: any OpenAI-compatible AI router
NEXUS_PROVIDER_OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
NEXUS_PROVIDER_OPENROUTER_API_KEY=your-private-key
NEXUS_PROVIDER_OPENROUTER_MODEL=provider/model-id
NEXUS_DEFAULT_PROVIDER=openrouter

# Native providers (optional)
ANTHROPIC_API_KEY=your-private-key
ANTHROPIC_MODEL=claude-model-id
GEMINI_API_KEY=your-private-key
GEMINI_MODEL=gemini-model-id

# Logging & Debug
LOG_LEVEL=info
DEBUG=0
```

### Connect Provider & Pilih Model

```
/connect                    # buka katalog provider yang bisa dicari
/provider                   # alias untuk /connect
/models                     # cari model, dikelompokkan berdasarkan provider
/model                      # alias untuk /models
/model openrouter/model-id  # pilih model secara langsung
/provider list              # lihat provider yang telah terdaftar
/provider remove openrouter # hapus provider lokal dan credential lokal
```

Pilih provider dari katalog, lalu masukkan API key melalui prompt tersembunyi. Credential dari alur koneksi disimpan terpisah di `~/.nexuscli/auth.json` (permission file `0600`, direktori `0700` pada sistem yang mendukungnya), bukan di repository. Provider khusus juga bisa ditambahkan melalui opsi **Custom OpenAI-compatible provider**.

Konfigurasi environment lama tetap didukung. Contoh `/provider add` masih tersedia untuk mendaftarkan endpoint dan referensi environment variable:

```
/provider add my-router https://gateway.example/v1 MY_ROUTER_API_KEY - My Router
```

Simpan API key di `.env` lokal atau environment shell dan jangan commit credential ke Git. Model dipilih dengan format `provider/model-id` dan ditemukan dari endpoint model provider yang sesuai.

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
nexuscode run "Tulis fungsi fibonacci di fib.js" --approve

# Output JSON terstruktur ke stdout (exit code 0 jika sukses, 1 jika gagal)
nexuscode run "Review src/cli.js" --json --mode plan > review.json
```

Format output JSON:
```json
{
  "sessionId": "ses_...",
  "model": "openrouter/provider-model-id",
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

## Daftar Slash Command

Ketik `/` untuk melihat seluruh command beserta deskripsinya. Gunakan tombol panah untuk navigasi, **Enter** untuk memilih, dan **Tab** untuk melengkapi command:

| Kategori | Command | Deskripsi |
|---|---|---|
| **Modes** | `/plan` | Mode read-only (eksekusi file modification diblokir) |
| | `/build` | Mode default (eksekusi penuh: write, edit, bash) |
| **Provider & Model** | `/connect` / `/provider` | Cari katalog dan hubungkan provider |
| | `/models` / `/model` | Cari model dari provider yang terhubung, dikelompokkan per provider |
| | `/model <provider/model>` | Ganti model aktif secara langsung |
| | `/provider list` | Tampilkan daftar provider yang terdaftar |
| **Model & Context** | `/compact` | Ringkas riwayat percakapan secara manual untuk menghemat token |
| | `/compact` | Ringkas riwayat percakapan secara manual untuk menghemat token |
| | `/cost` / `/usage` | Laporan konsumsi token dan estimasi biaya per sesi |
| **Workspace & Git** | `/diff` | Tampilkan git diff perubahan workspace saat ini |
| | `/undo` | Kembalikan workspace ke checkpoint git sebelumnya |
| | `/redo` | Majukan workspace ke checkpoint git berikutnya |
| | `/checkpoints` | Tampilkan seluruh daftar checkpoint dalam sesi ini |
| | `/checkpoint [label]` | Buat checkpoint git manual bernama |
| **Session** | `/sessions` | Daftar seluruh sesi tersimpan dan jumlah token |
| | `/resume <id>` | Lanjutkan sesi yang pernah disimpan |
| | `/new` | Mulai sesi percakapan baru yang bersih |
| | `/export [path]` | Ekspor percakapan ke file HTML mandiri (dark mode) |
| **System** | `/doctor` | Cek kesehatan env (Node, Git, Docker, API Key, Tools) |
| | `/init` | Scaffold folder `.agent/` dan `agent.config.json` |
| | `/clear` | Bersihkan layar terminal dan gambar ulang status banner |
| | `/help` | Tampilkan menu bantuan command |
| | `/exit` / `quit` | Keluar dari Nexus CLI |

---

## Lisensi

MIT