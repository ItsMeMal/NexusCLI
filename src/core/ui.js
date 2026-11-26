import readline from 'node:readline';
import fs from 'node:fs';

let APP_VERSION = '0.1.4';
try { APP_VERSION = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || APP_VERSION; } catch {}

// ─── ANSI Styling Palette (Truecolor + High-contrast ANSI fallback) ──────────

export const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',

  // Standard Colors
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',

  // High-Vibrancy Modern Terminal Tones
  brightWhite: '\x1b[97m',
  brand: '\x1b[38;2;129;140;248m',     // Electric Indigo
  teal: '\x1b[38;2;45;212;191m',       // Bright Teal
  amber: '\x1b[38;2;251;191;36m',      // Warm Amber
  emerald: '\x1b[38;2;52;211;153m',    // Lush Mint Green
  rose: '\x1b[38;2;244;63;94m',        // Coral Rose
  slate: '\x1b[38;2;148;163;184m',     // Cool Slate
  muted: '\x1b[38;2;100;116;139m',     // Muted Blue-Gray

  // Badges & Backgrounds
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgDark: '\x1b[100m',
  bgBrand: '\x1b[48;2;67;56;202m',
  bgSlate: '\x1b[48;2;30;41;59m'
};

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Animated terminal spinner with high-res elapsed timer
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
    // Clear any previous interval before starting a new one (prevents timer leaks
    // when start() is called twice, e.g. consecutive tool events).
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.startTime = Date.now();
    this.active = true;
    this.frameIndex = 0;

    // Hide cursor
    process.stdout.write('\x1b[?25l');

    this.timer = setInterval(() => {
      const frame = SPINNER_FRAMES[this.frameIndex % SPINNER_FRAMES.length];
      const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
      const line = `\r  ${c.cyan}${frame}${c.reset} ${c.bold}${this.text}${c.reset} ${c.dim}(${elapsed}s)${c.reset}`;
      process.stdout.write(line + '\x1b[K');
      this.frameIndex++;
    }, 80);
  }

  update(text) {
    this.text = text;
  }

  stop(clear = true) {
    // Track whether the spinner actually owns the current line. A second stop()
    // (e.g. onDone after the response already streamed) must NOT wipe output.
    const wasRunning = Boolean(this.timer);
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.active = false;
    // Show cursor
    process.stdout.write('\x1b[?25h');
    if (clear && wasRunning) {
      process.stdout.write('\r\x1b[K');
    }
  }

  succeed(text) {
    this.stop(true);
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    console.log(`  ${c.green}✔${c.reset} ${text || this.text} ${c.dim}(${elapsed}s)${c.reset}`);
  }

  fail(text) {
    this.stop(true);
    console.log(`  ${c.red}✖${c.reset} ${text || this.text}`);
  }

  info(text) {
    this.stop(true);
    console.log(`  ${c.blue}ℹ${c.reset} ${text}`);
  }
}

/**
 * Short startup motion: a compact progress sweep, never a full-screen animation.
 * It is skipped for piped output and can be disabled with NEXUS_NO_ANIMATION=1.
 */
export async function renderStartupAnimation({
  output = process.stdout,
  isTTY = Boolean(output.isTTY),
  intervalMs = 90,
  sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
  if (!isTTY || process.env.NEXUS_NO_ANIMATION === '1') return false;

  const frames = ['◴', '◷', '◶', '◵'];
  const stages = [
    { label: 'Preparing workspace', progress: 24 },
    { label: 'Initializing agent runtime', progress: 52 },
    { label: 'Connecting local interface', progress: 82 },
    { label: 'Ready', progress: 100 }
  ];

  output.write('\x1b[?25l');
  try {
    for (let index = 0; index < stages.length; index++) {
      const stage = stages[index];
      const filled = Math.round(stage.progress / 10);
      const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
      const glyph = index === stages.length - 1 ? '✓' : frames[index % frames.length];
      const color = index === stages.length - 1 ? c.green : c.cyan;
      output.write(
        '\r\x1b[K  ' + color + glyph + c.reset + ' ' +
        c.bold + 'NEXUSCODE' + c.reset + ' ' +
        c.dim + stage.label + c.reset + ' ' +
        color + bar + c.reset + ' ' + c.dim + stage.progress + '%' + c.reset
      );
      await sleep(intervalMs);
    }
    output.write('\n');
  } finally {
    output.write('\x1b[?25h');
  }
  return true;
}

/** Show a version alert without interrupting the normal prompt flow. */
export function renderUpdateNotice(updateInfo) {
  if (!updateInfo?.updateAvailable || !updateInfo.latestVersion) return false;
  console.log(
    `\n  ${c.bgYellow}${c.black}${c.bold} UPDATE AVAILABLE ${c.reset} ` +
    `${c.bold}NexusCode v${updateInfo.latestVersion}${c.reset} ` +
    `${c.dim}(installed v${updateInfo.currentVersion})${c.reset}`
  );
  console.log(`  Run ${c.cyan}${c.bold}/update${c.reset} to install the newer version.\n`);
  return true;
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
 * Strip ANSI escape sequences to compute visual character length
 */
export function stripAnsi(str) {
  return String(str || '').replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Pad a visual string considering ANSI codes
 */
export function padVisual(str, targetLen, align = 'left') {
  const visualLen = stripAnsi(str).length;
  const diff = Math.max(0, targetLen - visualLen);
  const pad = ' '.repeat(diff);
  return align === 'right' ? pad + str : str + pad;
}

/**
 * Render Welcome Banner (Agency / Linear / Claude Code grade)
 */
export function renderBanner({ sessionId, mode, model, serverUrl, gitBranch = 'clean' }) {
  const width = 76;
  const innerWidth = width - 4; // between "│ " and " │"
  const hr = '─'.repeat(width - 2);

  const modeBadge = mode === 'plan'
    ? `${c.bgYellow}${c.black}${c.bold} PLAN ${c.reset}`
    : `${c.bgGreen}${c.black}${c.bold} BUILD ${c.reset}`;

  const topBrand = `${c.bold}${c.brightWhite}✦ NEXUSCODE${c.reset} ${c.dim}v${APP_VERSION}${c.reset}`;
  const topStatus = `${c.green}● ONLINE${c.reset} ${modeBadge}`;
  const row1Gap = Math.max(1, innerWidth - stripAnsi(topBrand).length - stripAnsi(topStatus).length);

  // Interactive mascot & connection info rows
  const m1 = `  ${c.magenta}∧,,∧${c.reset}   `;
  const m2 = `${c.magenta}( ˘ᴗ˘ ) ${c.reset}`;
  const m3 = `${c.magenta}c( つ🪄*${c.reset}`;

  const shortSession = sessionId && sessionId.length > 28 ? sessionId.slice(0, 26) + '…' : (sessionId || 'active');
  const infoW = innerWidth - 9;
  const r1Info = `${c.dim}Model:${c.reset} ${c.cyan}${c.bold}${model}${c.reset}   ${c.dim}Git:${c.reset} ${c.magenta} ${gitBranch}${c.reset}   ${c.dim}Endpoint:${c.reset} ${c.slate}${serverUrl.replace(/^http:\/\//, '')}${c.reset}`;
  const r2Info = `${c.dim}Session:${c.reset} ${c.slate}${shortSession}${c.reset}   ${c.dim}Permissions:${c.reset} ${c.amber}Smart Guardrails${c.reset}`;
  const r3Info = `${c.cyan}${c.bold}Nexus:${c.reset} ${c.dim}"Aku koordinasikan tools, agents, dan model untuk menyelesaikan tujuanmu."${c.reset}`;

  const hint1 = `${c.dim}Type any task or question • Enter ${c.bold}${c.cyan}/${c.reset}${c.dim} or press ${c.bold}${c.cyan}[Tab]${c.reset}${c.dim} for slash commands${c.reset}`;

  console.log(`\n${c.cyan}╭${hr}╮${c.reset}`);
  console.log(`${c.cyan}│${c.reset}  ${topBrand}${' '.repeat(row1Gap)}${topStatus}  ${c.cyan}│${c.reset}`);
  console.log(`${c.cyan}├${hr}┤${c.reset}`);
  console.log(`${c.cyan}│${c.reset}  ${padVisual(m1 + r1Info, innerWidth)}  ${c.cyan}│${c.reset}`);
  console.log(`${c.cyan}│${c.reset}  ${padVisual(m2 + r2Info, innerWidth)}  ${c.cyan}│${c.reset}`);
  console.log(`${c.cyan}│${c.reset}  ${padVisual(m3 + r3Info, innerWidth)}  ${c.cyan}│${c.reset}`);
  console.log(`${c.cyan}├${hr}┤${c.reset}`);
  console.log(`${c.cyan}│${c.reset}  ${padVisual(hint1, innerWidth)}  ${c.cyan}│${c.reset}`);
  console.log(`${c.cyan}╰${hr}╯${c.reset}\n`);
}

/**
 * Render complete categorized command menu in high-density 2-column card
 */
export function renderCommandList() {
  const width = 80;
  const hr = '─'.repeat(width - 2);
  const colW = 38;

  const leftCommands = [
    { cmd: '/plan', cat: 'MODE', desc: 'Read-only mode (block writes)' },
    { cmd: '/build', cat: 'MODE', desc: 'Full execution (write/bash)' },
    { cmd: '/diff', cat: 'GIT', desc: 'Show workspace git diff' },
    { cmd: '/undo', cat: 'GIT', desc: 'Revert last git step' },
    { cmd: '/redo', cat: 'GIT', desc: 'Re-apply reverted step' },
    { cmd: '/checkpoints', cat: 'GIT', desc: 'List git checkpoints' },
    { cmd: '/checkpoint [l]', cat: 'GIT', desc: 'Create manual checkpoint' },
    { cmd: '/doctor', cat: 'SYS', desc: 'System & env diagnostic' },
    { cmd: '/update', cat: 'SYS', desc: 'Update from GitHub main' },
    { cmd: '/abort', cat: 'SYS', desc: 'Stop the current task' },
    { cmd: '/init', cat: 'SYS', desc: 'Scaffold .agent/ config' },
    { cmd: '/clear', cat: 'UI', desc: 'Clear terminal screen' }
  ];

  const rightCommands = [
    { cmd: '/model [name]', cat: 'MODEL', desc: 'Switch or view active LLM' },
    { cmd: '/provider', cat: 'MODEL', desc: 'Open the provider selection menu' },
    { cmd: '/cost', cat: 'MODEL', desc: 'Token usage & USD pricing' },
    { cmd: '/usage', cat: 'MODEL', desc: 'Alias for /cost' },
    { cmd: '/compact', cat: 'MODEL', desc: 'Prune chat history for tokens' },
    { cmd: '/sessions', cat: 'SES', desc: 'List all saved sessions' },
    { cmd: '/resume <id>', cat: 'SES', desc: 'Resume session by ID' },
    { cmd: '/new', cat: 'SES', desc: 'Start clean new session' },
    { cmd: '/export [path]', cat: 'SES', desc: 'Export session to dark HTML' },
    { cmd: '/help', cat: 'HELP', desc: 'Show this command palette' },
    { cmd: '/exit', cat: 'SYS', desc: 'Exit CLI session' }
  ];

  const formatItem = (item) => {
    if (!item) return ' '.repeat(colW);
    const cmdStr = `${c.cyan}${c.bold}${item.cmd.padEnd(15, ' ')}${c.reset}`;
    const descStr = `${c.dim}${item.desc}${c.reset}`;
    return padVisual(`${cmdStr} ${descStr}`, colW);
  };

  console.log(`\n${c.cyan}╭── ✦ AVAILABLE SLASH COMMANDS ──────────────────────────────────────────────╮${c.reset}`);
  console.log(`${c.cyan}│${c.reset}  ${c.dim}Press ${c.bold}${c.cyan}[Tab]${c.reset}${c.dim} anytime to autocomplete commands or arguments${c.reset}${' '.repeat(16)}${c.cyan}│${c.reset}`);
  console.log(`${c.cyan}├──────────────────────────────────────┬───────────────────────────────────────┤${c.reset}`);
  console.log(`${c.cyan}│${c.reset}  ${c.bold}MODES & GIT OPERATIONS             ${c.reset} ${c.cyan}│${c.reset}  ${c.bold}MODEL, SESSIONS & SYSTEM            ${c.reset} ${c.cyan}│${c.reset}`);
  console.log(`${c.cyan}├──────────────────────────────────────┼───────────────────────────────────────┤${c.reset}`);

  const maxRows = Math.max(leftCommands.length, rightCommands.length);
  for (let i = 0; i < maxRows; i++) {
    const left = formatItem(leftCommands[i]);
    const right = formatItem(rightCommands[i]);
    console.log(`${c.cyan}│${c.reset}  ${left} ${c.cyan}│${c.reset}  ${right} ${c.cyan}│${c.reset}`);
  }

  console.log(`${c.cyan}╰──────────────────────────────────────┴───────────────────────────────────────╯${c.reset}\n`);
}

/**
 * Render Tool Execution Card
 */
export function renderToolCard(name, args, output, durationSec = 0, isSuccess = true) {
  const width = 74;
  const hr = '─'.repeat(width - 2);
  const argStr = JSON.stringify(args || {});
  const displayArg = argStr.length > 56 ? argStr.slice(0, 54) + '…' : argStr;

  console.log(`\n  ${c.slate}┌── ⚙️  ${c.bold}${c.cyan}${name}${c.reset} ${c.dim}${displayArg}${c.reset}`);
  
  if (output) {
    const lines = String(output).split(/\r?\n/).slice(0, 6);
    for (const l of lines) {
      const trimmed = l.length > 68 ? l.slice(0, 66) + '…' : l;
      console.log(`  ${c.slate}│${c.reset}  ${c.dim}${trimmed}${c.reset}`);
    }
    if (String(output).split(/\r?\n/).length > 6) {
      console.log(`  ${c.slate}│${c.reset}  ${c.dim}... (output truncated)${c.reset}`);
    }
  }

  const status = isSuccess
    ? `${c.green}✔ Completed in ${durationSec}s${c.reset}`
    : `${c.red}✖ Failed in ${durationSec}s${c.reset}`;

  console.log(`  ${c.slate}└──${c.reset} ${status}\n`);
}

/**
 * Render Security Confirmation Card
 */
export function renderSecurityPrompt({ tool, args, reason }) {
  const width = 74;
  const hr = '─'.repeat(width - 2);
  const argsFormatted = JSON.stringify(args || {}, null, 2);

  console.log(`\n${c.rose}╭── 🛑 SECURITY GUARDRAIL : AUTHORIZATION REQUIRED ──────────────────────────╮${c.reset}`);
  console.log(`${c.rose}│${c.reset}  The agent is requesting execution of a potentially sensitive operation.   ${c.rose}│${c.reset}`);
  console.log(`${c.rose}├${hr}┤${c.reset}`);
  console.log(`${c.rose}│${c.reset}  ${c.bold}Tool:${c.reset}    ${c.cyan}${c.bold}${tool}${c.reset}`);
  if (reason) {
    console.log(`${c.rose}│${c.reset}  ${c.bold}Reason:${c.reset}  ${c.amber}${reason}${c.reset}`);
  }
  console.log(`${c.rose}│${c.reset}  ${c.bold}Args:${c.reset}    ${c.dim}${JSON.stringify(args || {})}${c.reset}`);
  console.log(`${c.rose}├${hr}┤${c.reset}`);
  console.log(`${c.rose}│${c.reset}  Press ${c.bold}${c.green}[Y]${c.reset} to allow this turn  │  Press ${c.bold}${c.red}[N]${c.reset} to reject and abort       ${c.rose}│${c.reset}`);
  console.log(`${c.rose}╰${hr}╯${c.reset}`);
}

/**
 * Render diagnostic health report (/doctor)
 */
export function renderDoctorReport(data) {
  const width = 76;
  const hr = '─'.repeat(width - 2);

  console.log(`\n${c.cyan}╭── 🏥 SYSTEM DIAGNOSTIC HEALTH CHECK ───────────────────────────────────────╮${c.reset}`);
  console.log(`${c.cyan}│${c.reset}  ${c.bold}Component${c.reset}${' '.repeat(10)}${c.bold}Status${c.reset}${' '.repeat(4)}${c.bold}Details${c.reset}${' '.repeat(width - 39)}${c.cyan}│${c.reset}`);
  console.log(`${c.cyan}├${hr}┤${c.reset}`);

  const row = (name, ok, detail, warn = false) => {
    const mark = ok ? `${c.green}✔ OK   ${c.reset}` : (warn ? `${c.yellow}ℹ INFO ${c.reset}` : `${c.red}✖ FAIL ${c.reset}`);
    const namePadded = name.padEnd(18, ' ');
    const detailPadded = padVisual(detail, width - 33);
    console.log(`${c.cyan}│${c.reset}  ${c.bold}${namePadded}${c.reset}${mark} ${detailPadded} ${c.cyan}│${c.reset}`);
  };

  row('Node.js Runtime', data.nodeOk, `${process.version} (min >=20 required)`);
  row('Git Repository', data.gitOk, data.gitStatus);
  row('Docker Sandbox', data.dockerOk, data.dockerStatus, !data.dockerOk);
  row('Active Model', data.modelOk, `${data.model} (${data.provider})`);
  row('API Credentials', data.apiKeyOk, data.apiKeyStatus);
  row('Tool Registry', data.toolsCount > 0, `${data.toolsCount} registered operational tools`);
  row('Custom Subagents', data.agentsCount >= 0, `${data.agentsCount} agents loaded (.agent/agents/)`);
  row('Audit Logging', data.auditOk, data.auditStatus);

  console.log(`${c.cyan}├${hr}┤${c.reset}`);
  const summary = data.allHealthy
    ? `${c.green}✔ All core operational subsystems are online and healthy.${c.reset}`
    : `${c.amber}⚠️  Some optional subsystems are running in fallback mode.${c.reset}`;
  console.log(`${c.cyan}│${c.reset}  ${padVisual(summary, width - 4)}  ${c.cyan}│${c.reset}`);
  console.log(`${c.cyan}╰${hr}╯${c.reset}\n`);
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

  const width = 74;
  const hr = '─'.repeat(width - 2);

  console.log(`\n${c.cyan}╭── 📊 SESSION TOKEN USAGE & COST BREAKDOWN ────────────────────────────────╮${c.reset}`);
  console.log(`${c.cyan}│${c.reset}  ${c.dim}Model:${c.reset}               ${c.bold}${c.brightWhite}${modelConfig.name || session.model}${c.reset}`);
  console.log(`${c.cyan}│${c.reset}  ${c.dim}Prompt Tokens (In):${c.reset}  ${c.bold}${promptTok.toLocaleString()}${c.reset} tokens ${c.dim}(rate: $${inRate}/1M)${c.reset}`);
  console.log(`${c.cyan}│${c.reset}  ${c.dim}Comp. Tokens (Out):${c.reset}  ${c.bold}${compTok.toLocaleString()}${c.reset} tokens ${c.dim}(rate: $${outRate}/1M)${c.reset}`);
  console.log(`${c.cyan}│${c.reset}  ${c.dim}Total Context:${c.reset}       ${c.bold}${c.cyan}${totalTok.toLocaleString()}${c.reset} tokens`);
  console.log(`${c.cyan}├${hr}┤${c.reset}`);

  if (inRate > 0 || outRate > 0) {
    console.log(`${c.cyan}│${c.reset}  ${c.dim}Est. Prompt Cost:${c.reset}    $${inCost} USD`);
    console.log(`${c.cyan}│${c.reset}  ${c.dim}Est. Output Cost:${c.reset}    $${outCost} USD`);
    console.log(`${c.cyan}│${c.reset}  ${c.bold}Total Estimated:${c.reset}     ${c.bold}${c.emerald}$${totalCost} USD${c.reset}`);
  } else {
    console.log(`${c.cyan}│${c.reset}  ${c.bold}Pricing Tier:${c.reset}        ${c.emerald}Zero priced / Local or Free Tier${c.reset}`);
  }

  console.log(`${c.cyan}╰${hr}╯${c.reset}\n`);
}

export default {
  c,
  Spinner,
  badge,
  stripAnsi,
  padVisual,
  renderBanner,
  renderStartupAnimation,
  renderUpdateNotice,
  renderCommandList,
  renderToolCard,
  renderSecurityPrompt,
  renderDoctorReport,
  renderCostReport
};
