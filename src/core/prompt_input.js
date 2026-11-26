import readline from 'node:readline';
import { c, stripAnsi } from './ui.js';

export const COMMANDS_REGISTRY = [
  { cmd: '/plan', cat: 'Mode', desc: 'Read-only mode (block file modifications)', needsArg: false },
  { cmd: '/build', cat: 'Mode', desc: 'Full execution mode (write/edit/bash enabled)', needsArg: false },
  { cmd: '/diff', cat: 'Git', desc: 'Show workspace git diff vs snapshot/checkpoint', needsArg: false },
  { cmd: '/undo', cat: 'Git', desc: 'Revert last git step to previous checkpoint', needsArg: false },
  { cmd: '/redo', cat: 'Git', desc: 'Re-apply reverted git checkpoint', needsArg: false },
  { cmd: '/checkpoints', cat: 'Git', desc: 'List all git checkpoints captured in session', needsArg: false },
  { cmd: '/checkpoint', cat: 'Git', desc: 'Create manual checkpoint (/checkpoint [label])', needsArg: true },
  { cmd: '/model', cat: 'Model', desc: 'Search and select a model grouped by provider', needsArg: false },
  { cmd: '/models', cat: 'Model', desc: 'Alias for /model', needsArg: false },
  { cmd: '/provider', cat: 'Model', desc: 'Connect or manage AI providers', needsArg: false },
  { cmd: '/connect', cat: 'Model', desc: 'Alias for /provider — connect an AI provider', needsArg: false },
  { cmd: '/cost', cat: 'Model', desc: 'View token usage stats and estimated cost breakdown', needsArg: false },
  { cmd: '/usage', cat: 'Model', desc: 'Alias for /cost', needsArg: false },
  { cmd: '/compact', cat: 'Model', desc: 'Manually prune and compact conversation context', needsArg: false },
  { cmd: '/doctor', cat: 'System', desc: 'Run system & workspace diagnostic health checks', needsArg: false },
  { cmd: '/update', cat: 'System', desc: 'Update NexusCode from the latest GitHub main source', needsArg: false },
  { cmd: '/abort', cat: 'System', desc: 'Stop the currently running agent task', needsArg: false },
  { cmd: '/init', cat: 'System', desc: 'Scaffold .agent/ config & agent.config.json', needsArg: false },
  { cmd: '/sessions', cat: 'Session', desc: 'List all saved conversation sessions', needsArg: false },
  { cmd: '/resume', cat: 'Session', desc: 'Resume a saved session by ID (/resume <id>)', needsArg: true },
  { cmd: '/new', cat: 'Session', desc: 'Start a brand new conversation session', needsArg: false },
  { cmd: '/export', cat: 'Session', desc: 'Export session to dark-mode HTML (/export [file])', needsArg: true },
  { cmd: '/clear', cat: 'UI', desc: 'Clear terminal screen', needsArg: false },
  { cmd: '/help', cat: 'Help', desc: 'Show full 2-column command card', needsArg: false },
  { cmd: '/exit', cat: 'System', desc: 'Exit Nexus CLI session', needsArg: false },
  { cmd: 'exit', cat: 'System', desc: 'Exit Nexus CLI session', needsArg: false }
];

/** Urutan kategori untuk grouping list command di hint bar. */
const CAT_ORDER = ['Mode', 'Git', 'Model', 'Session', 'System', 'UI', 'Help'];

/**
 * Bangun list baris hint untuk input slash.
 * Semua command yang cocok ditampilkan, dikelompokkan per kategori.
 * @param {string} query - Bagian pertama buffer (contoh: "/" atau "/pl")
 * @param {Array} matches - Flat list command yang cocok
 * @param {number} tabCycleIdx - Indeks chip yang ter-highlight
 * @returns {Array<string>} Baris-baris hint
 */
export function buildHintLines(query, matches, tabCycleIdx = -1, { columns, rows } = {}) {
  const width = Math.max(28, (Number(columns) || Number(process.stdout.columns) || 80) - 2);
  const terminalRows = Math.max(12, Number(rows) || Number(process.stdout.rows) || 24);
  const maxVisible = Math.max(2, Math.min(6, terminalRows - 9));
  const selectedIndex = matches.length
    ? (tabCycleIdx >= 0 ? tabCycleIdx % matches.length : -1)
    : -1;
  const start = selectedIndex < 0
    ? 0
    : Math.max(0, Math.min(matches.length - maxVisible, selectedIndex - Math.floor(maxVisible / 2)));
  const end = Math.min(matches.length, start + maxVisible);
  const visible = matches.slice(start, end);
  const remainingAbove = start;
  const remainingBelow = matches.length - end;
  const lines = [
    '  ' + c.brightWhite + 'COMMANDS' + c.reset +
    '  ' + c.dim + '/' + query.replace(/^\//, '') + '  ·  ' + matches.length + ' matches' + c.reset
  ];

  if (remainingAbove > 0) lines.push('  ' + c.dim + '↑ ' + remainingAbove + ' more above' + c.reset);

  visible.forEach((command, offset) => {
    const index = start + offset;
    const selected = index === selectedIndex;
    const marker = selected ? c.teal + c.bold + '›' + c.reset : c.muted + ' ' + c.reset;
    const category = clipPickerText(command.cat || 'Command', 8);
    const name = clipPickerText(command.cmd, 16);
    const fixedWidth = 2 + 1 + 1 + 8 + 2 + 16 + 2;
    const description = clipPickerText(command.desc, Math.max(0, width - fixedWidth));
    const nameColor = selected ? c.brightWhite + c.bold : c.white;
    lines.push(
      '  ' + marker + ' ' +
      c.magenta + padPickerText(category, 8) + c.reset + '  ' +
      nameColor + padPickerText(name, 16) + c.reset + '  ' +
      c.dim + description + c.reset
    );
  });

  if (remainingBelow > 0) lines.push('  ' + c.dim + '↓ ' + remainingBelow + ' more below' + c.reset);
  lines.push('  ' + c.dim + clipPickerText('↑↓ move  ·  Tab complete  ·  Enter run  ·  Esc clear', width - 2) + c.reset);
  return lines;
}

/**
 * Interactive selection menu (UI pemilihan) dengan navigasi panah.
 * Render box option bernomor; ↑/↓ memilih, Enter konfirmasi, Esc batal,
 * angka = lompat langsung ke opsi.
 *
 * @param {Object} options
 * @param {string} options.title - Judul menu (contoh: "PILIH MODEL")
 * @param {string} [options.icon] - Emoji ikon judul
 * @param {Array<{label: string, desc?: string, active?: boolean}>} options.options
 * @returns {Promise<number>} Indeks opsi terpilih, atau -1 jika batal
 */

export function filterPickerOptions(options, query = '') {
  const needle = String(query || '').trim().toLowerCase();
  const entries = (options || []).map((option, index) => ({ option, index }));
  if (!needle) return entries;

  const score = (value) => {
    const text = String(value || '').toLowerCase();
    if (text.includes(needle)) return text.indexOf(needle) === 0 ? 3 : 2;
    let cursor = 0;
    for (const char of needle) {
      cursor = text.indexOf(char, cursor);
      if (cursor < 0) return 0;
      cursor++;
    }
    return 1;
  };

  return entries
    .map(entry => ({
      ...entry,
      score: Math.max(
        score(entry.option.label),
        score(entry.option.desc),
        score(entry.option.category),
        score(entry.option.id)
      )
    }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
}

/**
 * Return a stable, clamped viewport into a searchable picker list.
 * The selected index always refers to the filtered list passed by the caller.
 */
export function getPickerWindow(items, selectedIndex = 0, maxVisible = 10) {
  const list = Array.isArray(items) ? items : [];
  const limit = Math.max(1, Math.floor(Number(maxVisible) || 1));
  if (!list.length) {
    return { start: 0, end: 0, items: [], selectedIndex: -1, hasAbove: false, hasBelow: false };
  }

  const requestedIndex = Number.isInteger(selectedIndex) ? selectedIndex : 0;
  const selected = Math.max(0, Math.min(list.length - 1, requestedIndex));
  const start = Math.max(0, Math.min(
    Math.max(0, list.length - limit),
    selected - Math.floor(limit / 2)
  ));
  const end = Math.min(list.length, start + limit);

  return {
    start,
    end,
    items: list.slice(start, end),
    selectedIndex: selected,
    hasAbove: start > 0,
    hasBelow: end < list.length
  };
}

function displayWidth(value) {
  return Array.from(stripAnsi(String(value ?? ''))).reduce((width, char) => {
    const code = char.codePointAt(0);
    return width + (
      code >= 0x1100 && (
        code <= 0x115f || code === 0x2329 || code === 0x232a ||
        (code >= 0x2e80 && code <= 0xa4cf) ||
        (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe10 && code <= 0xfe19) ||
        (code >= 0xfe30 && code <= 0xfe6f) ||
        (code >= 0xff00 && code <= 0xff60) ||
        (code >= 0xffe0 && code <= 0xffe6) ||
        (code >= 0x1f300 && code <= 0x1faff)
      ) ? 2 : 1
    );
  }, 0);
}

function clipPickerText(value, maxWidth) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ');
  if (maxWidth <= 0) return '';
  if (displayWidth(text) <= maxWidth) return text;
  const result = [];
  let width = 0;
  for (const char of text) {
    const charWidth = displayWidth(char);
    if (width + charWidth > Math.max(0, maxWidth - 1)) break;
    result.push(char);
    width += charWidth;
  }
  return result.join('') + (maxWidth > 1 ? '…' : '');
}

function padPickerText(value, width) {
  const text = String(value ?? '');
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

export function formatPickerOption(option, { index = 0, selected = false, width = 76 } = {}) {
  const innerWidth = Math.max(12, width - 4);
  const status = String(option.status || (option.active ? 'ACTIVE' : option.connected ? 'CONNECTED' : '')).toUpperCase();
  const statusWidth = Math.min(displayWidth(status), Math.max(0, Math.floor(innerWidth * 0.24)));
  const prefixWidth = 5; // marker, index, and spacing
  const statusReserve = status ? statusWidth + 1 : 0;
  const available = Math.max(8, innerWidth - prefixWidth - statusReserve);
  const labelWidth = Math.max(8, Math.min(displayWidth(option.label || ''), Math.floor(available * 0.58)));
  const descWidth = Math.max(0, available - labelWidth - 2);
  const label = clipPickerText(option.label || '', labelWidth);
  const desc = clipPickerText(option.desc || '', descWidth);
  const prefix =
    (selected ? c.cyan + c.bold + '›' + c.reset : c.dim + ' ' + c.reset) +
    ' ' + c.muted + String(index + 1).padStart(2, ' ') + c.reset + ' ';
  const labelPart = (selected ? c.brightWhite + c.bold : c.white) + label + c.reset;
  const descPart = desc ? '  ' + c.dim + desc + c.reset : '';
  const statusColor = status.includes('ACTIVE') || status.includes('CONNECTED')
    ? c.green
    : status ? c.amber : c.reset;
  const statusPart = status ? ' ' + statusColor + c.bold + clipPickerText(status, statusWidth) + c.reset : '';
  const occupied = prefixWidth + displayWidth(label) +
    (desc ? 2 + displayWidth(desc) : 0) +
    (status ? 1 + statusWidth : 0);
  const gap = ' '.repeat(Math.max(0, innerWidth - occupied));
  return c.cyan + '│' + c.reset + ' ' + prefix + labelPart + descPart + gap + statusPart + ' ' + c.cyan + '│' + c.reset;
}

export async function promptSelect({ title, icon = '', options: opts = [], footer, searchable = false, maxVisible = 10 }) {
  if (!opts.length) return -1;

  const terminalColumns = Number(process.stdout.columns) || 80;
  const boxW = Math.max(24, Math.min(100, terminalColumns - 1));
  const innerWidth = boxW - 4;
  const visibleLimit = Math.max(3, Math.min(16, Number(maxVisible) || 10));
  const foot = footer || '↑↓ navigate • Enter select • Esc cancel';
  const titleText = clipPickerText((icon ? icon + '  ' : '') + title, boxW - 8);
  const topRow = c.cyan + '╭─' + c.reset + c.brightWhite + c.bold + titleText + c.reset +
    c.cyan + ' ' + '─'.repeat(Math.max(1, boxW - 4 - displayWidth(titleText))) + '╮' + c.reset;
  const separator = c.cyan + '├' + '─'.repeat(boxW - 2) + '┤' + c.reset;
  const bottomRow = c.cyan + '╰' + '─'.repeat(boxW - 2) + '╯' + c.reset;

  const allEntries = () => opts.map((option, index) => ({ option, index }));
  const renderBlock = (entries, cursor, query, scrollStart) => {
    const lines = [topRow];
    if (searchable) {
      const searchText = query ? 'Search: ' + query : 'Search: type to filter';
      const content = clipPickerText(searchText, innerWidth);
      lines.push(c.cyan + '│' + c.reset + ' ' + c.dim + padPickerText(content, innerWidth) + c.reset + ' ' + c.cyan + '│' + c.reset);
      lines.push(separator);
    }

    const visible = entries.slice(scrollStart, scrollStart + visibleLimit);
    let previousCategory = null;
    visible.forEach((entry, visibleIndex) => {
      const category = entry.option.category || '';
      if (category && category !== previousCategory) {
        const categoryText = clipPickerText(category.toUpperCase(), innerWidth);
        lines.push(c.cyan + '│' + c.reset + ' ' + c.magenta + c.bold +
          padPickerText(categoryText, innerWidth) + c.reset + ' ' + c.cyan + '│' + c.reset);
        previousCategory = category;
      }
      lines.push(formatPickerOption(entry.option, {
        index: entry.index,
        selected: scrollStart + visibleIndex === cursor,
        width: boxW
      }));
    });

    if (!visible.length) {
      const empty = padPickerText('No matching options.', innerWidth);
      lines.push(c.cyan + '│' + c.reset + ' ' + c.dim + empty + c.reset + ' ' + c.cyan + '│' + c.reset);
    }
    if (scrollStart > 0 || scrollStart + visibleLimit < entries.length) {
      const counter = `Showing ${scrollStart + 1}-${Math.min(scrollStart + visibleLimit, entries.length)} of ${entries.length}`;
      lines.push(c.cyan + '│' + c.reset + ' ' + c.dim + padPickerText(counter, innerWidth) + c.reset + ' ' + c.cyan + '│' + c.reset);
    }
    lines.push(bottomRow);
    lines.push('  ' + c.dim + clipPickerText((searchable ? 'Type to search • ' : '') + foot, boxW - 4) + c.reset);
    return lines;
  };

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const entries = allEntries();
    for (const line of renderBlock(entries, -1, '', 0)) process.stdout.write(line + '\n');
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      process.stdout.write('  Select a number [1-' + opts.length + '] (Enter to cancel): ');
      rl.question('', (answer) => {
        rl.close();
        const number = Number.parseInt(answer.trim(), 10);
        resolve(Number.isInteger(number) && number >= 1 && number <= opts.length ? number - 1 : -1);
      });
    });
  }

  return new Promise((resolve) => {
    let query = '';
    let entries = allEntries();
    let cursor = Math.max(0, entries.findIndex(entry => entry.option.active));
    let scrollStart = 0;
    let drawn = 0;

    const ensureVisible = () => {
      if (cursor < scrollStart) scrollStart = cursor;
      if (cursor >= scrollStart + visibleLimit) scrollStart = cursor - visibleLimit + 1;
      scrollStart = Math.max(0, Math.min(scrollStart, Math.max(0, entries.length - visibleLimit)));
    };

    const redraw = () => {
      ensureVisible();
      const lines = renderBlock(entries, cursor, query, scrollStart);
      if (drawn > 0) process.stdout.write('\x1b[' + (drawn - 1) + 'A');
      lines.forEach((line, index) => {
        process.stdout.write((index === 0 ? '\r\x1b[K' : '\n\x1b[K') + line);
      });
      if (drawn > lines.length) {
        for (let index = lines.length; index < drawn; index++) process.stdout.write('\n\x1b[K');
        process.stdout.write('\x1b[' + (drawn - lines.length) + 'A');
      }
      drawn = lines.length;
    };

    const finish = (result) => {
      if (drawn > 0) {
        process.stdout.write('\x1b[' + (drawn - 1) + 'A');
        for (let index = 0; index < drawn; index++) {
          process.stdout.write((index === 0 ? '\r' : '\n') + '\x1b[K');
        }
        process.stdout.write('\x1b[' + drawn + 'A\r');
        drawn = 0;
      }
      process.stdout.write('\n');
      process.stdin.removeListener('keypress', onKeypress);
      if (!wasRaw) process.stdin.setRawMode(false);
      resolve(result);
    };

    readline.emitKeypressEvents(process.stdin);
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const updateQuery = (nextQuery) => {
      query = nextQuery;
      entries = searchable ? filterPickerOptions(opts, query) : allEntries();
      const active = entries.findIndex(entry => entry.option.active);
      cursor = active >= 0 ? active : 0;
      scrollStart = 0;
      redraw();
    };

    const onKeypress = (str, key = {}) => {
      if (key.ctrl && key.name === 'c') {
        finish(-1);
        return;
      }
      if (key.name === 'escape') {
        finish(-1);
        return;
      }
      if (key.name === 'up') {
        if (cursor > 0) { cursor--; redraw(); }
        return;
      }
      if (key.name === 'down') {
        if (cursor < entries.length - 1) { cursor++; redraw(); }
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        finish(entries[cursor]?.index ?? -1);
        return;
      }
      if (searchable && key.ctrl && key.name === 'u') {
        updateQuery('');
        return;
      }
      if (searchable && key.name === 'backspace') {
        updateQuery(Array.from(query).slice(0, -1).join(''));
        return;
      }
      if (searchable && str && !key.ctrl && !key.meta && !key.name?.startsWith('arrow') && str >= ' ') {
        updateQuery(query + str);
      }
    };

    process.stdin.on('keypress', onKeypress);
    redraw();
  });
}

async function promptLine({ message, initialValue = '', mask = false, validate } = {}) {
  if (mask && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error('Secret input requires an interactive terminal. Use a private environment variable in non-interactive mode.');
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(message + ': ', (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }

  return new Promise((resolve, reject) => {
    let value = String(initialValue || '');
    let drawn = false;
    readline.emitKeypressEvents(process.stdin);
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const render = (error = '') => {
      const display = mask ? '•'.repeat(value.length) : value;
      process.stdout.write('\r\x1b[K' + c.cyan + message + c.reset + ': ' + display);
      if (error) process.stdout.write('\n' + c.yellow + error + c.reset);
      drawn = true;
    };
    const cleanup = () => {
      process.stdin.removeListener('keypress', onKeypress);
      if (!wasRaw) process.stdin.setRawMode(false);
    };
    const onKeypress = (str, key = {}) => {
      if (key.ctrl && key.name === 'c') {
        cleanup();
        process.stdout.write('\n');
        reject(new Error('Input cancelled.'));
        return;
      }
      if (key.name === 'escape') {
        cleanup();
        process.stdout.write('\n');
        resolve(null);
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        const error = validate ? validate(value) : undefined;
        if (error) { render(error); return; }
        cleanup();
        process.stdout.write('\n');
        resolve(value);
        return;
      }
      if (key.name === 'backspace' || key.name === 'delete') {
        value = value.slice(0, -1);
        render();
        return;
      }
      if (key.ctrl && key.name === 'u') {
        value = '';
        render();
        return;
      }
      if (str && !key.ctrl && !key.meta && str.length === 1 && str >= ' ') {
        value += str;
        render();
      }
    };

    process.stdin.on('keypress', onKeypress);
    render();
  });
}

export async function promptText(options = {}) {
  return promptLine(options);
}

export async function promptSecret(message = 'API key') {
  return promptLine({ message, mask: true, validate: value => value.trim() ? undefined : 'Required' });
}

/**
 * Prompt user for input with real-time slash suggestions.
 * Shows a compact, glitch-free 1-line suggestions bar below prompt.
 * Supports Tab autocomplete, arrow history, and direct execution.
 * 
 * @param {Object} options
 * @param {string} options.header - Line 1 of prompt (e.g. Starship status bar)
 * @param {string} options.arrow - Line 2 arrow (e.g. "╰─❯ ")
 * @param {Array<string>} [options.history] - Command history for Up/Down arrows
 * @returns {Promise<string>} User input line
 */
export async function promptWithAutocomplete({ header = '', arrow = '╰─❯ ', history = [], onInterrupt = null }) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      process.stdout.write(header + arrow);
      rl.question('', (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }

  return new Promise((resolve) => {
    let buffer = '';
    let cursorPos = 0;
    let tabCycleIdx = -1;
    let historyIdx = -1;
    let drawnHintLines = 0;

    readline.emitKeypressEvents(process.stdin);
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();

    if (header) {
      process.stdout.write(header);
    }

    /**
     * Tulis block hint di bawah baris prompt dengan clearing yang benar:
     * semua baris lama di-clear, lalu naik kembali ke baris prompt.
     * @param {Array<string>} lines - Baris hint baru (bisa kosong)
     */
    const drawHintBlock = (lines) => {
      const rows = Math.max(drawnHintLines, lines.length);
      if (rows === 0) {
        drawnHintLines = 0;
        return;
      }
      process.stdout.write('\n');
      for (let i = 0; i < rows; i++) {
        if (i > 0) process.stdout.write('\n');
        process.stdout.write('\x1b[K');
        if (lines[i]) process.stdout.write(lines[i]);
      }
      process.stdout.write(`\x1b[${rows}A`);
      drawnHintLines = Math.max(lines.length, 1);
    };

    const clearHintBlock = () => {
      if (drawnHintLines === 0) return;
      process.stdout.write('\n');
      for (let i = 0; i < drawnHintLines; i++) {
        if (i > 0) process.stdout.write('\n');
        process.stdout.write('\x1b[K');
      }
      process.stdout.write(`\x1b[${drawnHintLines}A`);
      drawnHintLines = 0;
    };

    const render = () => {
      const arrowVisualLen = stripAnsi(arrow).length;
      const targetCol = arrowVisualLen + cursorPos + 1;

      // 1. Draw prompt line
      process.stdout.write('\r\x1b[K' + arrow + buffer);

      // 2. Build hint lines for slash input
      const isSlash = buffer.startsWith('/');
      let hintLines = [];
      if (isSlash) {
        const query = buffer.trim().toLowerCase().split(/\s+/)[0];
        const matches = COMMANDS_REGISTRY.filter((cmd) => cmd.cmd.toLowerCase().startsWith(query));
        if (matches.length > 0) {
          hintLines = buildHintLines(query, matches, tabCycleIdx);
        } else {
          hintLines = [`  ${c.amber}✦ No command match for "${query}"${c.reset} ${c.dim}(press [Enter] for menu)${c.reset}`];
        }
      }

      // 3. Draw hint block below prompt, then return cursor to prompt line
      drawHintBlock(hintLines);
      process.stdout.write(`\x1b[${targetCol}G`);
    };

    const cleanupAndResolve = (result) => {
      clearHintBlock();
      process.stdout.write('\r\x1b[K' + arrow + result + '\n');

      process.stdin.removeListener('keypress', onKeypress);
      if (!wasRaw) {
        process.stdin.setRawMode(false);
      }
      resolve(result);
    };

    const onKeypress = (str, key) => {
      // Ctrl+C: interrupt the active operation when a handler is provided;
      // otherwise return the normal exit command so the caller can clean up.
      if (key && key.ctrl && key.name === 'c') {
        if (typeof onInterrupt === 'function') {
          onInterrupt();
          cleanupAndResolve('');
        } else {
          cleanupAndResolve('exit');
        }
        return;
      }

      // Ctrl+D: EOF
      if (key && key.ctrl && key.name === 'd') {
        cleanupAndResolve('exit');
        return;
      }

      const isSlash = buffer.startsWith('/');
      const query = buffer.trim().toLowerCase().split(/\s+/)[0];
      const matches = isSlash
        ? COMMANDS_REGISTRY.filter((c) => c.cmd.toLowerCase().startsWith(query))
        : [];

      // Enter / Return
      if (key && (key.name === 'return' || key.name === 'enter')) {
        // If user highlighted a tab suggestion and pressed enter
        if (isSlash && matches.length > 0 && tabCycleIdx >= 0) {
          const chosen = matches[tabCycleIdx % matches.length];
          if (chosen) {
            if (!chosen.needsArg) {
              cleanupAndResolve(chosen.cmd);
              return;
            } else {
              buffer = chosen.cmd + ' ';
              cursorPos = buffer.length;
              tabCycleIdx = -1;
              render();
              return;
            }
          }
        }
        cleanupAndResolve(buffer.trim());
        return;
      }

      // Tab key: Cycle autocompletion
      if (key && key.name === 'tab') {
        if (isSlash && matches.length > 0) {
          tabCycleIdx = (tabCycleIdx + 1) % matches.length;
          const chosen = matches[tabCycleIdx];
          if (chosen) {
            buffer = chosen.cmd + (chosen.needsArg ? ' ' : '');
            cursorPos = buffer.length;
            render();
            return;
          }
        }
        return;
      }

      // Escape key: Clear input
      if (key && key.name === 'escape') {
        buffer = '';
        cursorPos = 0;
        tabCycleIdx = -1;
        render();
        return;
      }

      // Arrow Up
      if (key && key.name === 'up') {
        if (isSlash && matches.length > 0) {
          tabCycleIdx = tabCycleIdx > 0 ? tabCycleIdx - 1 : matches.length - 1;
          const chosen = matches[tabCycleIdx];
          if (chosen) {
            buffer = chosen.cmd + (chosen.needsArg ? ' ' : '');
            cursorPos = buffer.length;
            render();
            return;
          }
        } else if (history.length > 0) {
          if (historyIdx < history.length - 1) {
            historyIdx++;
            buffer = history[history.length - 1 - historyIdx] || '';
            cursorPos = buffer.length;
            render();
          }
          return;
        }
      }

      // Arrow Down
      if (key && key.name === 'down') {
        if (isSlash && matches.length > 0) {
          tabCycleIdx = tabCycleIdx < matches.length - 1 ? tabCycleIdx + 1 : 0;
          const chosen = matches[tabCycleIdx];
          if (chosen) {
            buffer = chosen.cmd + (chosen.needsArg ? ' ' : '');
            cursorPos = buffer.length;
            render();
            return;
          }
        } else if (history.length > 0) {
          if (historyIdx > 0) {
            historyIdx--;
            buffer = history[history.length - 1 - historyIdx] || '';
            cursorPos = buffer.length;
            render();
          } else if (historyIdx === 0) {
            historyIdx = -1;
            buffer = '';
            cursorPos = 0;
            render();
          }
          return;
        }
      }

      // Arrow Left
      if (key && key.name === 'left') {
        if (cursorPos > 0) {
          cursorPos--;
          render();
        }
        return;
      }

      // Arrow Right
      if (key && key.name === 'right') {
        if (cursorPos < buffer.length) {
          cursorPos++;
          render();
        }
        return;
      }

      // Home / End
      if (key && key.name === 'home') {
        cursorPos = 0;
        render();
        return;
      }
      if (key && key.name === 'end') {
        cursorPos = buffer.length;
        render();
        return;
      }

      // Backspace
      if (key && (key.name === 'backspace' || key.name === 'delete')) {
        if (cursorPos > 0) {
          buffer = buffer.slice(0, cursorPos - 1) + buffer.slice(cursorPos);
          cursorPos--;
          tabCycleIdx = -1;
          render();
        }
        return;
      }

      // Printable character
      if (str && str.length === 1 && !key.ctrl && !key.meta) {
        buffer = buffer.slice(0, cursorPos) + str + buffer.slice(cursorPos);
        cursorPos++;
        tabCycleIdx = -1;
        render();
        return;
      }
    };

    process.stdin.on('keypress', onKeypress);
    render();
  });
}
