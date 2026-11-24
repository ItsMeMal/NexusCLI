import readline from 'node:readline';

// ANSI escape codes
export const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',

  // Foreground colors
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  brightWhite: '\x1b[97m',

  // Background badges
  bgBlue: '\x1b[44m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgDark: '\x1b[100m'
};

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Animated terminal spinner
 */
export class Spinner {
  constructor(initialText = '') {
    this.text = initialText;
    this.frameIndex = 0;
    this.timer = null;
    this.startTime = Date.now();
    this.active = false;
  }

  start(text) {
    if (text) this.text = text;
    this.startTime = Date.now();
    this.active = true;
    this.frameIndex = 0;

    // Hide cursor
    process.stdout.write('\x1b[?25l');

    this.timer = setInterval(() => {
      const frame = SPINNER_FRAMES[this.frameIndex % SPINNER_FRAMES.length];
      const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
      const line = `\r${c.cyan}${frame}${c.reset} ${this.text} ${c.dim}(${elapsed}s)${c.reset}`;
      process.stdout.write(line + '\x1b[K');
      this.frameIndex++;
    }, 80);
  }

  update(text) {
    this.text = text;
  }

  stop(clear = true) {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.active = false;
    // Show cursor
    process.stdout.write('\x1b[?25h');
    if (clear) {
      process.stdout.write('\r\x1b[K');
    }
  }

  succeed(text) {
    this.stop(true);
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    console.log(`${c.green}✔${c.reset} ${text || this.text} ${c.dim}(${elapsed}s)${c.reset}`);
  }

  fail(text) {
    this.stop(true);
    console.log(`${c.red}✖${c.reset} ${text || this.text}`);
  }

  info(text) {
    this.stop(true);
    console.log(`${c.blue}ℹ${c.reset} ${text}`);
  }
}

/**
 * Format badge e.g. [BUILD] or [PLAN]
 */
export function badge(label, color = 'cyan') {
  const bg = color === 'green' ? c.bgGreen
    : color === 'blue' ? c.bgBlue
    : color === 'yellow' ? c.bgYellow
    : c.bgCyan;
  return `${bg}${c.black}${c.bold} ${label} ${c.reset}`;
}

/**
 * Render welcome banner box
 */
export function renderBanner({ sessionId, mode, model, serverUrl, gitBranch = 'clean' }) {
  const width = 64;
  const line = '─'.repeat(width);
  const modeBadge = mode === 'plan' ? `${c.yellow}[PLAN]${c.reset}` : `${c.green}[BUILD]${c.reset}`;

  console.log(`\n${c.cyan}┌${line}┐${c.reset}`);
  console.log(`${c.cyan}│${c.reset}  ${c.bold}${c.brightWhite}✦ Nexus Coding Agent CLI${c.reset} ${c.dim}v0.1.0${c.reset}${' '.repeat(width - 32)}${c.cyan}│${c.reset}`);
  console.log(`${c.cyan}│${c.reset}  ${c.dim}Mode:${c.reset} ${modeBadge}  ${c.dim}Model:${c.reset} ${c.cyan}${model}${c.reset}  ${c.dim}Branch:${c.reset} ${c.magenta}${gitBranch}${c.reset}${' '.repeat(Math.max(0, width - 42 - model.length - gitBranch.length))}${c.cyan}│${c.reset}`);
  console.log(`${c.cyan}│${c.reset}  ${c.dim}Session:${c.reset} ${c.gray}${sessionId}${c.reset}${' '.repeat(Math.max(0, width - 11 - sessionId.length))}${c.cyan}│${c.reset}`);
  console.log(`${c.cyan}│${c.reset}  ${c.dim}Type ${c.bold}/${c.reset}${c.dim} or press ${c.bold}Tab${c.reset}${c.dim} for commands • Type your prompt to code${c.reset}${' '.repeat(Math.max(0, width - 64))}${c.cyan}│${c.reset}`);
  console.log(`${c.cyan}└${line}┘${c.reset}\n`);
}

/**
 * Render complete categorized command menu
 */
export function renderCommandList() {
  console.log(`\n${c.bold}${c.cyan}AVAILABLE SLASH COMMANDS${c.reset}`);
  console.log(`${c.gray}Press Tab to autocomplete commands at any time.${c.reset}\n`);

  const categories = [
    {
      name: '🔄 MODES',
      commands: [
        { cmd: '/plan', desc: 'Switch to read-only PLAN mode (no file edits or destructive bash)' },
        { cmd: '/build', desc: 'Switch to BUILD mode (full execution: write, edit, bash)' }
      ]
    },
    {
      name: '🧠 MODEL & CONTEXT',
      commands: [
        { cmd: '/model [name]', desc: 'Switch LLM model or show current model' },
        { cmd: '/compact', desc: 'Manually compact conversation history to save tokens' },
        { cmd: '/cost', desc: 'View token usage stats and estimated cost breakdown' }
      ]
    },
    {
      name: '📂 WORKSPACE & GIT',
      commands: [
        { cmd: '/diff', desc: 'View unstaged & staged workspace git diff' },
        { cmd: '/undo', desc: 'Revert workspace to previous git checkpoint' },
        { cmd: '/redo', desc: 'Re-apply next git checkpoint in history' },
        { cmd: '/checkpoints', desc: 'List all git checkpoints captured in this session' },
        { cmd: '/checkpoint [l]', desc: 'Create a manual named checkpoint (e.g. /checkpoint before-refactor)' }
      ]
    },
    {
      name: '💬 SESSION MANAGEMENT',
      commands: [
        { cmd: '/sessions', desc: 'List all saved sessions with token counts' },
        { cmd: '/resume <id>', desc: 'Resume a saved session by ID' },
        { cmd: '/new', desc: 'Start a brand new conversation session' },
        { cmd: '/export [path]', desc: 'Export current session to self-contained HTML file' }
      ]
    },
    {
      name: '🛠️ SYSTEM & DIAGNOSTICS',
      commands: [
        { cmd: '/doctor', desc: 'Run environment and workspace diagnostic health check' },
        { cmd: '/init', desc: 'Verify or scaffold .agent/ configuration in current folder' },
        { cmd: '/clear', desc: 'Clear terminal screen' },
        { cmd: '/help', desc: 'Show this command menu' },
        { cmd: '/exit', desc: 'Exit Nexus CLI (or quit / exit)' }
      ]
    }
  ];

  for (const cat of categories) {
    console.log(`${c.bold}${cat.name}${c.reset}`);
    for (const item of cat.commands) {
      const paddedCmd = item.cmd.padEnd(18, ' ');
      console.log(`  ${c.cyan}${paddedCmd}${c.reset} ${c.dim}—${c.reset} ${item.desc}`);
    }
    console.log('');
  }
}

/**
 * Render diagnostic health report (/doctor)
 */
export function renderDoctorReport(data) {
  console.log(`\n${c.bold}${c.cyan}🏥 NEXUS DIAGNOSTIC REPORT${c.reset}`);
  console.log('─'.repeat(50));

  const check = (ok, label, detail) => {
    const mark = ok ? `${c.green}✔ OK   ${c.reset}` : `${c.red}✖ FAIL ${c.reset}`;
    console.log(`${mark} ${c.bold}${label.padEnd(16)}${c.reset} : ${detail}`);
  };

  check(data.nodeOk, 'Node.js', `${process.version} (min >=20.0.0 required)`);
  check(data.gitOk, 'Git Repository', data.gitStatus);
  check(data.dockerOk, 'Docker Sandbox', data.dockerStatus);
  check(data.modelOk, 'Active Model', `${data.model} (Provider: ${data.provider})`);
  check(data.apiKeyOk, 'API Key', data.apiKeyStatus);
  check(data.toolsCount > 0, 'Loaded Tools', `${data.toolsCount} registered tools`);
  check(data.agentsCount >= 0, 'Subagents', `${data.agentsCount} custom subagents (.agent/agents/)`);
  check(data.auditOk, 'Audit Log', data.auditStatus);

  console.log('─'.repeat(50));
  if (data.allHealthy) {
    console.log(`${c.green}✔ All core systems operational.${c.reset}\n`);
  } else {
    console.log(`${c.yellow}⚠️ Some optional components require attention (see above).${c.reset}\n`);
  }
}

/**
 * Render token cost breakdown (/cost)
 */
export function renderCostReport(session, modelConfig) {
  const u = session.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const promptTok = u.prompt_tokens || 0;
  const compTok = u.completion_tokens || 0;
  const totalTok = u.total_tokens || (promptTok + compTok);

  const inRate = modelConfig.inputPrice || 0;
  const outRate = modelConfig.outputPrice || 0;

  const inCost = ((promptTok / 1_000_000) * inRate).toFixed(4);
  const outCost = ((compTok / 1_000_000) * outRate).toFixed(4);
  const totalCost = (parseFloat(inCost) + parseFloat(outCost)).toFixed(4);

  console.log(`\n${c.bold}${c.cyan}📊 SESSION USAGE & COST REPORT${c.reset}`);
  console.log('─'.repeat(48));
  console.log(`  ${c.dim}Model:${c.reset}            ${c.bold}${modelConfig.name || session.model}${c.reset}`);
  console.log(`  ${c.dim}Prompt Tokens:${c.reset}    ${c.bold}${promptTok.toLocaleString()}${c.reset} ${c.dim}(rate: $${inRate}/1M)${c.reset}`);
  console.log(`  ${c.dim}Comp. Tokens:${c.reset}     ${c.bold}${compTok.toLocaleString()}${c.reset} ${c.dim}(rate: $${outRate}/1M)${c.reset}`);
  console.log(`  ${c.dim}Total Tokens:${c.reset}     ${c.bold}${c.cyan}${totalTok.toLocaleString()}${c.reset}`);
  console.log('─'.repeat(48));
  if (inRate > 0 || outRate > 0) {
    console.log(`  ${c.dim}Est. Input Cost:${c.reset}  $${inCost}`);
    console.log(`  ${c.dim}Est. Output Cost:${c.reset} $${outCost}`);
    console.log(`  ${c.dim}Total Est. Cost:${c.reset}  ${c.bold}${c.green}$${totalCost} USD${c.reset}`);
  } else {
    console.log(`  ${c.dim}Est. Cost:${c.reset}        ${c.green}Free tier / Zero priced model${c.reset}`);
  }
  console.log('─'.repeat(48) + '\n');
}

export default {
  c,
  Spinner,
  badge,
  renderBanner,
  renderCommandList,
  renderDoctorReport,
  renderCostReport
};
