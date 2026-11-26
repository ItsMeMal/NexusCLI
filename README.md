# NexusCode

**A general-purpose AI orchestrator for your terminal.**

NexusCode brings AI models, tools, MCP servers, plugins, and specialist agents into one workflow. It understands the task, chooses an execution path, coordinates the work, and checks the result — whether you're writing code, researching a topic, analyzing information, planning work, or automating a process.

[![CI](https://github.com/ItsMeMal/NexusCode/actions/workflows/ci.yml/badge.svg)](https://github.com/ItsMeMal/NexusCode/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)

---

## Why NexusCode?

Most AI coding tools are built around a single workflow. NexusCode is designed as a **general-purpose orchestrator**: it can answer directly, use tools, split larger tasks into focused workstreams, delegate independent tasks to specialist agents, and combine the results.

Its architecture separates the orchestration core from its interfaces:

- **Core** — agent loop, context management, permissions, tools, sessions, and extensions.
- **CLI** — interactive terminal workflow for everyday use.
- **TUI** — terminal interface built with Ink and React.
- **HTTP/SSE server** — local client/server interface with streamed responses.

## Features

### General-purpose orchestration

- Handles software engineering, research, writing, analysis, planning, troubleshooting, and automation.
- Breaks complex requests into manageable tasks and delegates independent work to specialist agents.
- Coordinates tool execution and consolidates results into a final response.
- Supports interactive sessions and non-interactive execution for scripts and CI.

### Providers and model selection

- Searchable provider catalog with connection status.
- OpenAI-compatible APIs and gateways, Anthropic, and Google Gemini.
- Model discovery from connected providers, with models grouped by provider.
- Secure, masked API-key entry for providers that use API keys.
- **Mallss Nexus Route OAuth** — connect through browser sign-in and consent. NexusCode uses Authorization Code + PKCE, refreshes access tokens automatically, and does not require you to create or paste a gateway API key.
- Environment-based configuration for existing workflows.

### Tools and extensibility

NexusCode includes 10 built-in tools:

| Tool | Purpose |
|---|---|
| `read_file` | Read workspace files |
| `write_file` | Create or overwrite files |
| `edit_file` | Apply targeted file edits |
| `bash` | Execute shell commands |
| `grep` | Search file contents |
| `glob` | Find files by pattern |
| `todo` | Track task progress |
| `webfetch` | Retrieve web content |
| `repo_map` | Inspect repository structure |
| `task` | Delegate work to specialist agents |

Extend the workflow with:

- **Custom agents** — Markdown definitions in `.agent/agents/`.
- **MCP servers** — stdio, Streamable HTTP, and SSE transports configured in `.agent/mcp.json`.
- **Plugins** — JavaScript or ESM modules in `.agent/plugins/`, with tool registration and lifecycle hooks.
- **Built-in No AI Slop skill** — keeps implementation and interface work focused, specific, and free from generic template patterns.
- **Custom slash commands** — Markdown command templates in `.agent/commands/`.

### Context and session management

- Token estimation and automatic context compaction.
- Output pruning to keep long sessions manageable.
- Persistent conversation sessions with resume support.
- Export conversations as standalone HTML files.
- Git checkpoints with undo and redo support.

### Safety and observability

- Configurable `allow`, `ask`, and `deny` tool permissions.
- Optional Docker-backed workspace sandboxing when Docker is available.
- Secret redaction for sensitive values in output and logs.
- Prompt-injection and jailbreak defenses: project files, search results, subagent summaries, plugin/MCP responses, and retrieved pages are treated as untrusted data.
- Shell command guardrails: command chaining, substitutions, pipes, and redirections require explicit approval; destructive system commands are denied by default.
- Workspace path checks resolve existing symlink ancestors to prevent reads/writes through paths that escape the workspace.
- Tool execution audit records in `.agent/audit.log`.
- Git snapshots for reviewing and recovering workspace changes.

---

## Requirements

- **Node.js 20 or newer**
- npm
- Git (recommended for workspace snapshots and undo/redo)
- Docker (optional; enables the Docker-backed execution sandbox)

## Installation

### From npm

```bash
npm install -g @mallssz/nexuscode-cli
```

Start NexusCode from your workspace:

```bash
cd path/to/your-project
nexuscode
```

You can also run it without a global installation:

```bash
npm exec --package=@mallssz/nexuscode-cli -- nexuscode
```

### From source

```bash
git clone https://github.com/ItsMeMal/NexusCode.git
cd NexusCode
npm ci
npm start
```

For local development, run `npm link` from the repository root to expose the `nexuscode` command from your checkout.

---

## Quick start

1. Open a terminal in the directory you want NexusCode to work in.
2. Start the CLI with `nexuscode`.
3. Connect an AI provider with `/connect`.
4. Choose a model with `/models`.
5. Describe the task you want to complete.

For example:

```text
/connect
/models
Review this repository for security issues. Do not modify any files.
```

Use `/plan` for strictly read-only work, `/build` for direct execution, or `/auto` to let NexusCode choose a safe route for each request. Auto treats unclear requests as read-only; explicit change requests use build routing and still follow the configured permission prompts.

## Connect an AI provider

Run `/connect` (or `/provider`) to open the searchable provider catalog. Select a provider and follow its connection flow.

### NexusCode — browser OAuth (Mallss Nexus Route)

Select **NexusCode** in the provider catalog. It connects to your Mallss Nexus Route gateway using browser authorization. NexusCode will:

1. Start a temporary callback listener on `127.0.0.1`.
2. Open the Mallss Nexus Route sign-in and authorization page in your browser.
3. Return an authorization code to the local callback.
4. Exchange the code using OAuth 2.0 Authorization Code with PKCE.
5. Store the access and refresh tokens in your local NexusCode profile.

No manually generated or copied API key is needed. Access tokens are refreshed automatically. Requests use the models, account permissions, usage limits, and credits available to your Mallss Nexus Route account.

You can reconnect or revoke the connection from the provider menu. The OAuth connection is local to the machine and user profile where you authorize it.

### API-key providers

For other providers, select one from the catalog and enter its API key through the masked terminal prompt. Credentials are kept separately from provider metadata.

### Environment configuration

NexusCode loads a `.env` file from the current working directory. You can also configure providers directly through environment variables:

```env
# Example: an OpenAI-compatible provider or AI router
NEXUS_PROVIDER_OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
NEXUS_PROVIDER_OPENROUTER_API_KEY=your-private-key
NEXUS_PROVIDER_OPENROUTER_MODEL=provider/model-id
NEXUS_DEFAULT_PROVIDER=openrouter

# Native provider credentials (optional)
ANTHROPIC_API_KEY=your-private-key
ANTHROPIC_MODEL=claude-model-id

GEMINI_API_KEY=your-private-key
GEMINI_MODEL=gemini-model-id

# Logging
LOG_LEVEL=info
DEBUG=0
```

Replace the example values with credentials and model IDs from your provider. Never commit private keys, access tokens, or `.env` files to source control.

### Custom OpenAI-compatible endpoints

Use the **Custom OpenAI-compatible provider** option in `/connect` to add an endpoint interactively.

You can also register a provider using an environment-variable reference:

```text
/provider add my-router https://gateway.example/v1 MY_ROUTER_API_KEY - My Router
```

Then set `MY_ROUTER_API_KEY` in your local `.env` file or shell environment. Select models using the `provider/model-id` format.

### Local credential storage

Provider metadata and credentials are stored separately under the local NexusCode configuration directory:

| File | Contents |
|---|---|
| `~/.nexuscli/providers.json` | Provider metadata and connection settings |
| `~/.nexuscli/auth.json` | Locally stored API credentials and OAuth tokens |

On platforms that support POSIX file permissions, NexusCode restricts the configuration directory to `0700` and credential files to `0600`. These files are local to your user profile; they should not be added to a project repository or shared.

---

## Working with custom agents

Create a Markdown file in `.agent/agents/`, for example `.agent/agents/explore.md`:

```markdown
---
description: Read-only codebase explorer
model: gpt-4o-mini
tools: read_file, grep, glob, repo_map
permission: read-only
---

You are a codebase exploration specialist.
Inspect the project and return a concise summary.
Do not modify files.
```

The frontmatter supports:

| Field | Description |
|---|---|
| `description` | What the specialist agent is responsible for |
| `model` | Optional model override |
| `tools` | Comma-separated list of tools available to the agent |
| `permission` | Permission profile for the agent |

The main agent can delegate focused work through the `task` tool. Independent tasks can be run in parallel.

## Working with plugins

Plugins are loaded from `.agent/plugins/` when the local NexusCode server starts. Use `.js` or `.mjs` files (the package runs as an ES module). Use the `registerTool(tool)` helper provided in the plugin context to add tools; `ctx.registry` is read-only.

Create `.agent/plugins/example.js`:

```javascript
export default function myPlugin({ registerTool, hooks }) {
  registerTool({
    name: 'custom_ping',
    description: 'Return a response for a host.',
    parameters: {
      type: 'object',
      properties: { host: { type: 'string' } },
      required: ['host']
    },
    async execute({ host }) {
      return `Pong: ${host}`;
    }
  });

  hooks.on_message.push(async ({ message }) => {
    // The latest user message is mutable before it reaches the model.
  });

  hooks.before_tool.push(async ({ name, args }) => {
    // Inspect or adjust tool arguments before permission checks.
  });

  hooks.after_tool.push(async (event) => {
    // Inspect or transform event.output after execution.
  });
}
```

The plugin API provides:

| API | Purpose |
|---|---|
| `registerTool(tool)` | Add a tool to the active agent registry |
| `hooks.on_message` | Inspect or modify the latest user message |
| `hooks.before_tool` | Inspect or modify arguments, or set `cancelled = true` and `reason` to block a call |
| `hooks.after_tool` | Inspect or modify the completed tool output |
| `on(name, handler)` | Register a handler for one of the supported lifecycle hooks |

Hooks run sequentially. A failing hook is logged and does not prevent later hooks from running. Changes to `before_tool` arguments are still checked by the normal permission manager; a plugin hook cannot grant permission to a tool call.

**Permission defaults:** plugin tools require approval in build mode and are blocked in read-only plan mode because their side effects cannot be inferred safely. Configure an explicit tool rule in `agent.config.json` only when you trust that plugin.

Plugins execute as local JavaScript with the same operating-system permissions as the NexusCode process. Only install or enable code you trust. Restart the CLI/server after adding or changing a plugin.

## Custom slash commands

Create a Markdown template in `.agent/commands/`. For example, `.agent/commands/review.md`:

```markdown
Review the following code for correctness, maintainability, and security:

$ARGUMENTS

List actionable findings and explain their impact.
```

Run the command from the NexusCode prompt:

```text
/review src/core/loop.js
```

## Connect MCP servers

Configure MCP servers in `.agent/mcp.json`. NexusCode reads this file during startup, connects each configured server, discovers its tools, and registers them in the active agent tool registry. Connections are closed when the local server shuts down.

The configuration supports all three client transports:

```json
{
  "servers": [
    {
      "name": "filesystem",
      "command": "node",
      "args": ["examples/mcp-filesystem-server.mjs", "."]
    },
    {
      "name": "remote-tools",
      "url": "https://mcp.example.com/mcp",
      "transport": "streamable-http"
    },
    {
      "name": "legacy-service",
      "url": "https://mcp.example.com/sse",
      "transport": "sse"
    }
  ]
}
```

- **stdio** — use `command` and optional `args`, `env`, and `cwd`.
- **Streamable HTTP** — use an HTTP(S) `url`; this is the default transport for URL-based servers and can be selected explicitly with `"transport": "streamable-http"`.
- **SSE** — use an HTTP(S) `url` and set `"transport": "sse"` for servers that implement the legacy HTTP+SSE transport.

Discovered tools are registered with a normalized server-name prefix, for example:

```text
filesystem__read_file
remote_tools__search
```

The prefix prevents tools from different servers from sharing the same namespace. If a connection fails, NexusCode reports that server as failed and continues loading other configured servers.

**Permission defaults:** MCP tools require approval in build mode and are blocked in plan mode unless the permission model is deliberately changed in code. This prevents a remote tool with unknown side effects from bypassing read-only mode. Review the server and its tool descriptions before approving calls. MCP server processes and remote endpoints should be treated as trusted integrations.

## CLI commands

Type `/` in the interactive prompt to open the searchable command palette. Use the arrow keys to navigate, Enter to select, and Tab to complete a command.

| Command | Description |
|---|---|
| `/plan` | Switch to read-only mode |
| `/build` | Switch to full execution mode |
| `/auto` | Automatically choose a read-only or execution route per request |
| `/connect` · `/provider` | Connect or manage AI providers |
| `/models` · `/model` | Search and select a model |
| `/model <provider/model>` | Select a model directly |
| `/provider list` | List configured providers |
| `/provider add ...` | Register a custom provider |
| `/provider remove <id>` | Remove a locally registered provider |
| `/cost` · `/usage` | View token usage and estimated session costs |
| `/compact` | Compact conversation context |
| `/diff` | Show the workspace Git diff |
| `/undo` | Restore the previous Git checkpoint |
| `/redo` | Re-apply a reverted checkpoint |
| `/checkpoints` | List checkpoints in the current session |
| `/checkpoint [label]` | Create a named checkpoint |
| `/sessions` | List saved sessions |
| `/resume <id>` | Resume a saved session |
| `/new` | Start a new session |
| `/export [path]` | Export the current session to standalone HTML |
| `/doctor` | Run environment and workspace diagnostics |
| `/update` | Install the latest source from the official GitHub `main` branch |

Interactive startup checks GitHub `main` for a newer package version (cached for six hours). Set `NEXUS_DISABLE_UPDATE_CHECK=1` to disable this check. `/update` fast-forwards a source checkout and installs its dependencies, or updates a global installation from GitHub.
| `/init` | Create starter `.agent/` configuration |
| `/abort` | Stop the current agent task |
| `/clear` | Clear the terminal |
| `/help` | Show command help |
| `/exit` | Exit NexusCode |

---

## Non-interactive mode

Use `nexuscode run` to execute a prompt from a script, CI job, or terminal command:

```bash
# Run a task in the default build mode
nexuscode run "Create a small utility that formats dates"

# Run in read-only mode and emit structured JSON
nexuscode run "Review src/cli.js for bugs" --mode plan --json

# Select a model and approve tool actions non-interactively
nexuscode run "Add tests for the parser" --model openrouter/provider-model-id --approve
```

Available options include:

| Option | Description |
|---|---|
| `--json` | Write structured results to stdout |
| `--model <id>` | Override the selected model |
| `--mode <mode>` | Set the execution mode: `plan`, `build`, or `auto` |
| `--approve`, `--yes`, `-y` | Automatically approve permission prompts |
| `--debug` | Enable debug output |

The JSON result includes session information, the selected model and mode, the response, tool calls, error status, exit code, and token usage.

## Updating NexusCode

In the interactive CLI, run `/update` and confirm the update. NexusCode installs the latest source from `github:ItsMeMal/NexusCode#main` through npm. Restart the CLI after installation.

The updater follows the repository's `main` branch and does not change the package's declared version. The current development line remains **0.1.2**; the next package version is intentionally reserved for a later release.

A GitHub Actions example is available in [`.github/workflows/agent-review.yml`](.github/workflows/agent-review.yml).

---

## Local server and editor integration

Start the local HTTP/SSE server with:

```bash
npm run server
```

The server exposes the NexusCode session and streaming interface for compatible local clients.

A lightweight VS Code extension is included in `extensions/vscode/`. It provides commands to send a prompt or review selected code through the configured Nexus server.

---

## Development

Install dependencies and run the checks:

```bash
npm ci
npm test
npm run eval
```

Useful project scripts:

| Script | Description |
|---|---|
| `npm start` | Start the CLI |
| `npm run tui` | Start the Ink-based TUI |
| `npm run server` | Start the HTTP/SSE server |
| `npm test` | Run the Node.js test suite |
| `npm run eval` | Run deterministic evaluation tasks |
| `npm run pack:check` | Preview files included in the npm package |

The project uses Node.js built-in test tooling (`node:test`) and deterministic evaluation tasks to check core behavior.

## Project structure

```text
NexusCode/
├── .agent/
│   ├── agents/          # Custom specialist agents
│   ├── commands/        # Custom slash commands
│   ├── plugins/         # JavaScript/ESM plugins
│   └── mcp.json         # MCP server configuration
├── .github/workflows/   # CI and automation workflows
├── examples/            # MCP and extension examples
├── extensions/vscode/   # VS Code extension
├── evals/               # Deterministic evaluation tasks
├── schemas/             # Configuration JSON schemas
├── src/
│   ├── core/             # Agent orchestration and runtime
│   ├── providers/        # Provider adapters and OAuth
│   ├── tools/            # Built-in tools
│   ├── cli.js            # Interactive and non-interactive CLI
│   ├── server.js         # HTTP/SSE server
│   └── tui.js            # Ink-based terminal UI
├── test/                # Automated tests
├── AGENTS.md            # Project-level agent guidelines
├── agent.config.json    # Tool and shell permission policy
└── package.json
```

## Contributing

Issues and pull requests are welcome. Before submitting a change:

1. Keep changes focused and preserve unrelated behavior.
2. Add or update tests for behavioral changes.
3. Run `npm test` and `npm run eval`.
4. Never commit API keys, OAuth tokens, personal data, or local session files.

## License

NexusCode is released under the [MIT License](LICENSE).
