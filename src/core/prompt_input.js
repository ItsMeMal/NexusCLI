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
  { cmd: '/model', cat: 'Model', desc: 'Switch or view active LLM (/model <name>)', needsArg: true },
  { cmd: '/provider', cat: 'Model', desc: 'Open provider picker and switch the active LLM provider', needsArg: false },
  { cmd: '/cost', cat: 'Model', desc: 'View token usage stats and estimated cost breakdown', needsArg: false },
  { cmd: '/usage', cat: 'Model', desc: 'Alias for /cost', needsArg: false },
  { cmd: '/compact', cat: 'Model', desc: 'Manually prune and compact conversation context', needsArg: false },
  { cmd: '/doctor', cat: 'System', desc: 'Run system & workspace diagnostic health checks', needsArg: false },
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
function buildHintLines(query, matches, tabCycleIdx) {
  const lines = [
    `  ${c.cyan}${c.bold}AVAILABLE COMMANDS${c.reset} ${c.dim}• ${matches.length} match(es)${c.reset}`
  ];

  matches.forEach((command, index) => {
    const selected = tabCycleIdx >= 0 && (tabCycleIdx % matches.length) === index;
    const prefix = selected ? `${c.cyan}${c.bold}❯${c.reset}` : ' ';
    const name = selected
      ? `${c.cyan}${c.bold}${command.cmd.padEnd(15)}${c.reset}`
      : `${c.white}${command.cmd.padEnd(15)}${c.reset}`;
    lines.push(`  ${prefix} ${c.magenta}${command.cat.padEnd(8)}${c.reset} ${name} ${c.dim}${command.desc}${c.reset}`);
  });

  lines.push(`  ${c.cyan}✦${c.reset} ${c.dim}[↑↓] navigate • [Tab] complete • [Enter] choose • [Esc] close${c.reset}`);
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
export async function promptSelect({ title, icon = '', options: opts, footer }) {
  const boxW = 74;
  const foot = footer || '↑↓ pilih • [Enter] ok • [Esc] batal • ketik nomor';

  const titleText = ` ${icon ? icon + ' ' : ''}${c.bold}${title}${c.reset} `;
  const titleFill = Math.max(1, boxW - 3 - stripAnsi(titleText).length);
  const topRow = `${c.cyan}╭─${c.reset}${titleText}${c.dim}${'─'.repeat(titleFill)}${c.reset}${c.cyan}╮${c.reset}`;
  const bottomRow = `${c.cyan}╰${'─'.repeat(boxW - 2)}╯${c.reset}`;

  const optionRow = (o, i, isSel) => {
    const mark = o.active ? ` ${c.green}${c.bold}◀ aktif${c.reset}` : '';
    const prefix = isSel ? `${c.bgCyan}${c.black}${c.bold} ❯ ${c.reset}` : '   ';
    const num = `${c.magenta}${c.bold}[${i + 1}]${c.reset}`;
    const label = `${c.bold}${o.label}${c.reset}${mark}`;
    const desc = o.desc ? `  ${c.dim}${o.desc}${c.reset}` : '';
    return `${c.cyan}│${c.reset}${prefix}${num} ${label}${desc}`;
  };

  const renderBlock = (sel) => {
    const lines = [topRow];
    opts.forEach((o, i) => lines.push(optionRow(o, i, i === sel)));
    lines.push(bottomRow);
    lines.push(`  ${c.dim}${foot}${c.reset}`);
    return lines;
  };

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    // Fallback non-TTY: cetak list, minta input nomor
    for (const ln of renderBlock(-1)) process.stdout.write(ln + '\n');
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      process.stdout.write(`  ${c.bold}Pilih nomor [1-${opts.length}]${c.reset} ${c.dim}(Enter batal):${c.reset} `);
      rl.question('', (ans) => {
        rl.close();
        const n = parseInt(ans.trim(), 10);
        resolve(n >= 1 && n <= opts.length ? n - 1 : -1);
      });
    });
  }

  return new Promise((resolve) => {
    let sel = opts.findIndex((o) => o.active);
    if (sel < 0) sel = 0;
    let drawn = 0;

    const drawBlock = (lines) => {
      const prev = drawn;
      if (prev > 0) process.stdout.write(`\x1b[${prev - 1}A`);
      lines.forEach((ln, i) => {
        process.stdout.write((i === 0 ? '\r\x1b[K' : '\n\x1b[K') + ln);
      });
      drawn = lines.length;
    };

    const finish = (result) => {
      if (drawn > 0) {
        process.stdout.write(`\x1b[${drawn - 1}A`);
        for (let i = 0; i < drawn; i++) {
          process.stdout.write((i === 0 ? '\r' : '\n') + '\x1b[K');
        }
        process.stdout.write(`\x1b[${drawn}A\r`);
        drawn = 0;
      }
      process.stdout.write('\n');
      process.stdin.removeListener('keypress', onKeypress);
      if (!wasRaw) {
        process.stdin.setRawMode(false);
      }
      resolve(result);
    };

    readline.emitKeypressEvents(process.stdin);
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const onKeypress = (str, key) => {
      if (key && key.ctrl && key.name === 'c') {
        finish(-1);
        process.exit(0);
        return;
      }
      if (key && key.name === 'escape') {
        finish(-1);
        return;
      }
      if (key && key.name === 'up') {
        if (sel > 0) {
          sel--;
          drawBlock(renderBlock(sel));
        }
        return;
      }
      if (key && key.name === 'down') {
        if (sel < opts.length - 1) {
          sel++;
          drawBlock(renderBlock(sel));
        }
        return;
      }
      if (key && (key.name === 'return' || key.name === 'enter')) {
        finish(sel);
        return;
      }
      if (str && /^[0-9]$/.test(str)) {
        const target = parseInt(str, 10) - 1;
        if (target >= 0 && target < opts.length) {
          sel = target;
          drawBlock(renderBlock(sel));
        }
      }
    };

    process.stdin.on('keypress', onKeypress);
    drawBlock(renderBlock(sel));
  });
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
export async function promptWithAutocomplete({ header = '', arrow = '╰─❯ ', history = [] }) {
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
      // Ctrl+C: Cancel / Exit
      if (key && key.ctrl && key.name === 'c') {
        clearHintBlock();
        process.stdout.write('\n');
        process.stdin.removeListener('keypress', onKeypress);
        if (!wasRaw) process.stdin.setRawMode(false);
        process.exit(0);
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
