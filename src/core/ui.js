import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';

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


const NEXUS_MASCOT_POSES = {
  idle: [{ face: '•ᴗ•', sparkle: '✦' }, { face: '◕ᴗ◕', sparkle: '✧' }],
  thinking: [{ face: '•̀ᴗ•́', sparkle: '⌁' }, { face: '•ω•', sparkle: '✧' }, { face: '◕ω◕', sparkle: '✦' }],
  working: [{ face: '•̀_•́', sparkle: '⚙' }, { face: '•̀ᴗ•́', sparkle: '✦' }, { face: '◕ᴗ◕', sparkle: '✧' }],
  success: [{ face: '^ᴗ^', sparkle: '✓' }, { face: '•ᴗ•', sparkle: '✦' }],
  error: [{ face: ';ᴗ;', sparkle: '!' }, { face: '×ᴗ×', sparkle: '!' }]
};

export function getMascotPose(mood = 'idle', frameIndex = 0) {
  const poses = NEXUS_MASCOT_POSES[mood] || NEXUS_MASCOT_POSES.idle;
  return poses[Math.abs(Math.floor(Number(frameIndex) || 0)) % poses.length];
}

export function renderMascot(mood = 'idle', frameIndex = 0) {
  const pose = getMascotPose(mood, frameIndex);
  return ['     /\\_/\\', '  ✦ ( ' + pose.face + ' )', '     /づ' + pose.sparkle];
}

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
    this.mood = 'thinking';
  }

  start(text, mood = 'thinking') {
    if (text) this.text = text;
    this.mood = mood;
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
      const pose = getMascotPose(this.mood, this.frameIndex);
      const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
      const columns = Number(process.stdout.columns) || 80;
      const label = clipTerminalText(this.text, Math.max(12, columns - 28));
      const faceColor = this.mood === 'error' ? c.rose : this.mood === 'success' ? c.green : c.brand;
      const mascot = faceColor + '(' + pose.face + ')' + c.reset + ' ' + c.amber + pose.sparkle + c.reset;
      const line = `\r  ${mascot}  ${c.bold}${label}${c.reset} ${c.dim}(${elapsed}s)${c.reset}`;
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
    const pose = getMascotPose('success');
    console.log(`  ${c.green}(${pose.face}) ✓${c.reset} ${text || this.text} ${c.dim}(${elapsed}s)${c.reset}`);
  }

  fail(text) {
    this.stop(true);
    const pose = getMascotPose('error');
    console.log(`  ${c.rose}(${pose.face}) !${c.reset} ${text || this.text}`);
  }

  info(text) {
    this.stop(true);
    const pose = getMascotPose('idle');
    console.log(`  ${c.blue}(${pose.face}) ·${c.reset} ${text}`);
  }
}

/**
 * Short startup motion: a compact progress sweep, never a full-screen animation.
 * It is skipped for piped output and can be disabled with NEXUS_NO_ANIMATION=1.
 */
export async function renderStartupAnimation({
  output = process.stdout,
  isTTY = Boolean(output.isTTY),
  intervalMs = 120,
  sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
  if (!isTTY || process.env.NEXUS_NO_ANIMATION === '1') return false;

  const stages = [
    { mood: 'idle', frame: 0, label: 'Waking up your companion' },
    { mood: 'thinking', frame: 1, label: 'Checking the workspace' },
    { mood: 'success', frame: 0, label: 'Nexus is ready' }
  ];

  output.write('\x1b[?25l');
  try {
    for (let index = 0; index < stages.length; index++) {
      const stage = stages[index];
      const mascot = renderMascot(stage.mood, stage.frame);
      const lines = [
        '  ' + c.brand + c.bold + 'NEXI' + c.reset + '  ' + c.dim + 'YOUR NEXUS COMPANION' + c.reset,
        '  ' + c.brightWhite + mascot[0] + c.reset + '    ' + c.bold + 'NEXUSCODE' + c.reset,
        '  ' + c.brand + mascot[1] + c.reset + '    ' + c.dim + stage.label + c.reset,
        '  ' + c.brand + mascot[2] + c.reset
      ];
      if (index === 0) output.write('\n');
      else output.write('\x1b[4A');
      output.write(lines.map(line => '\r\x1b[K' + line).join('\n'));
      await sleep(intervalMs);
    }
    output.write('\n\n');
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

function terminalDisplayWidth(value) {
  return Array.from(stripAnsi(String(value ?? ''))).reduce((width, char) => {
    const code = char.codePointAt(0);
    const isWide = code >= 0x1100 && (
      code <= 0x115f || code === 0x2329 || code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff)
    );
    return width + (isWide ? 2 : 1);
  }, 0);
}

function clipTerminalText(value, maxWidth) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  const limit = Math.max(0, Number(maxWidth) || 0);
  if (terminalDisplayWidth(text) <= limit) return text;
  if (limit <= 1) return limit ? '…' : '';

  let result = '';
  let used = 0;
  for (const char of Array.from(text)) {
    const charWidth = terminalDisplayWidth(char);
    if (used + charWidth > limit - 1) break;
    result += char;
    used += charWidth;
  }
  return result + '…';
}

/**
 * Render Welcome Banner (Agency / Linear / Claude Code grade)
 */
export function renderBanner({ sessionId, mode, model, gitBranch = 'clean' }) {
  const columns = Number(process.stdout.columns) || 80;
  const width = Math.max(24, Math.min(92, columns - 4));
  const project = path.basename(process.cwd()) || 'workspace';
  const modeLabel = mode === 'plan' ? 'PLAN' : 'BUILD';
  const shortSession = sessionId && sessionId.length > 22
    ? sessionId.slice(0, 18) + '…'
    : (sessionId || 'active');
  const mascot = renderMascot('idle', 0);

  console.log('');
  if (width >= 66) {
    console.log('  ' + c.brand + mascot[0] + c.reset + '     ' + c.bold + c.brand + 'NEXUSCODE' + c.reset + '  ' + c.dim + 'v' + APP_VERSION + c.reset);
    console.log('  ' + c.brand + mascot[1] + c.reset + '   ' + c.brightWhite + 'A small companion for ambitious work.' + c.reset);
    console.log('  ' + c.brand + mascot[2] + c.reset + '     ' + c.green + '● ONLINE' + c.reset + '  ' + c.dim + modeLabel + c.reset);
  } else {
    console.log('  ' + c.bold + c.brand + 'NEXUSCODE' + c.reset + '  ' + c.dim + 'v' + APP_VERSION + c.reset);
    for (const line of mascot) console.log('  ' + c.brand + line + c.reset);
    console.log('  ' + c.green + '● ONLINE' + c.reset + '  ' + c.dim + modeLabel + c.reset);
  }

  console.log('\n  ' + c.muted + '─'.repeat(width) + c.reset);
  const row = (label, value) => {
    const key = String(label).toUpperCase().padEnd(10, ' ');
    const content = clipTerminalText(value, width - 13);
    console.log('  ' + c.muted + key + c.reset + ' ' + c.brightWhite + content + c.reset);
  };
  row('MODEL', model || 'not selected');
  row('WORKSPACE', project + '  ·  BRANCH ' + (gitBranch || 'clean'));
  row('SESSION', shortSession + '  ·  MODE ' + modeLabel);
  console.log('  ' + c.muted + '─'.repeat(width) + c.reset);
  console.log('\n  ' + c.brightWhite + c.bold + 'Ready when you are.' + c.reset);
  console.log('  ' + c.dim + 'Describe a task or type / to browse commands.' + c.reset + '\n');
}
/**
 * Build a compact status rail directly above the interactive prompt.
 */
export function renderSessionPrompt({ mode, gitBranch = 'main', model = '', columns = process.stdout.columns || 80 }) {
  const width = Math.max(24, Math.min(120, Number(columns) - 4 || 76));
  const modeLabel = mode === 'plan' ? 'PLAN' : 'BUILD';
  const branchLimit = Math.max(6, Math.min(20, Math.floor(width * 0.28)));
  const branch = clipTerminalText(gitBranch || 'clean', branchLimit);
  const prefix = '  ' + modeLabel + '  ·  ' + branch + '  ·  ';
  const modelLimit = Math.max(4, width - terminalDisplayWidth(prefix));
  const modelLabel = clipTerminalText(model || 'default', modelLimit);
  const modeColor = mode === 'plan' ? c.amber : c.teal;

  return {
    header:
      '  ' + modeColor + c.bold + modeLabel + c.reset +
      '  ' + c.muted + '·' + c.reset + '  ' +
      c.magenta + branch + c.reset +
      '  ' + c.muted + '·' + c.reset + '  ' +
      c.cyan + c.bold + modelLabel + c.reset + '\n',
    arrow: '  ' + c.teal + c.bold + '›' + c.reset + ' '
  };
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
  renderSessionPrompt,
  renderStartupAnimation,
  renderUpdateNotice,
  renderCommandList,
  renderToolCard,
  renderSecurityPrompt,
  renderDoctorReport,
  renderCostReport
};
