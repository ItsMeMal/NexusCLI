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
  { cmd: '/cost', cat: 'Model', desc: 'View token usage stats and estimated cost breakdown', needsArg: false },
  { cmd: '/usage', cat: 'Model', desc: 'Alias for /cost', needsArg: false },
  { cmd: '/compact', cat: 'Model', desc: 'Manually prune and compact conversation context', needsArg: false },
  { cmd: '/doctor', cat: 'System', desc: 'Run system & workspace diagnostic health checks', needsArg: false },
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

const PAGE_SIZE = 6;

/**
 * Prompt user for input with REAL-TIME slash command dropdown menu.
 * When user types '/', a floating dropdown menu instantly appears under the prompt line.
 * Supports ↑/↓ navigation, Tab autocompletion, Backspace, and Enter execution.
 * 
 * @param {Object} options
 * @param {string} options.header - Line 1 of prompt (e.g. Starship status bar)
 * @param {string} options.arrow - Line 2 arrow (e.g. "╰─❯ ")
 * @param {Array<string>} [options.history] - Command history for Up/Down arrows
 * @returns {Promise<string>} User input line
 */
export async function promptWithAutocomplete({ header = '', arrow = '╰─❯ ', history = [] }) {
  // If stdin is not a TTY (piped or automated), fallback to standard readline
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
    let selectedIdx = 0;
    let scrollOffset = 0;
    let historyIdx = -1;
    let lastRenderedExtraLines = 0;

    // Enable keypress events on stdin
    readline.emitKeypressEvents(process.stdin);
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();

    // Print initial header
    if (header) {
      process.stdout.write(header);
    }

    const render = () => {
      // 1. Move to beginning of arrow line and clear everything below
      process.stdout.write('\r\x1b[K'); // clear current line

      // Print arrow + buffer
      process.stdout.write(arrow + buffer);

      // Check if slash menu is active
      const isSlash = buffer.startsWith('/');
      let extraLinesCount = 0;

      if (isSlash) {
        const query = buffer.trim().toLowerCase().split(/\s+/)[0];
        const matches = COMMANDS_REGISTRY.filter((c) => c.cmd.toLowerCase().startsWith(query));

        if (matches.length > 0) {
          // Clamp selection
          if (selectedIdx >= matches.length) selectedIdx = matches.length - 1;
          if (selectedIdx < 0) selectedIdx = 0;

          // Compute scroll window
          if (selectedIdx < scrollOffset) {
            scrollOffset = selectedIdx;
          } else if (selectedIdx >= scrollOffset + PAGE_SIZE) {
            scrollOffset = selectedIdx - PAGE_SIZE + 1;
          }

          const visible = matches.slice(scrollOffset, scrollOffset + PAGE_SIZE);
          const hasAbove = scrollOffset > 0;
          const hasBelow = scrollOffset + PAGE_SIZE < matches.length;

          const lines = [];
          lines.push(`\n  ${c.cyan}┌── ✦ COMMAND SUGGESTIONS ${c.dim}(↑/↓ navigate • [Tab] complete • [Enter] select)${c.reset}`);

          if (hasAbove) {
            lines.push(`  ${c.cyan}│${c.reset}  ${c.yellow}▲ ... (${scrollOffset} more above)${c.reset}`);
          }

          visible.forEach((item, idx) => {
            const absIdx = scrollOffset + idx;
            const isSelected = absIdx === selectedIdx;
            const cursor = isSelected ? `${c.cyan}❯${c.reset}` : ' ';
            const cmdPadded = item.cmd.padEnd(16, ' ');
            const tag = `[${item.cat}]`.padEnd(9, ' ');

            if (isSelected) {
              lines.push(`  ${c.cyan}│${c.reset} ${cursor} ${c.cyan}${c.bold}${cmdPadded}${c.reset} ${c.dim}${tag}${c.reset} ${c.brightWhite}${item.desc}${c.reset}`);
            } else {
              lines.push(`  ${c.cyan}│${c.reset} ${cursor} ${c.bold}${cmdPadded}${c.reset} ${c.dim}${tag}${c.reset} ${c.dim}${item.desc}${c.reset}`);
            }
          });

          if (hasBelow) {
            const remaining = matches.length - (scrollOffset + PAGE_SIZE);
            lines.push(`  ${c.cyan}│${c.reset}  ${c.yellow}▼ ... (${remaining} more below)${c.reset}`);
          }

          lines.push(`  ${c.cyan}└── ${c.dim}(${selectedIdx + 1} of ${matches.length} matches)${c.reset}`);

          extraLinesCount = lines.length;
          process.stdout.write(lines.join('\n'));

          // Move cursor back up to arrow line and position at cursor
          process.stdout.write(`\x1b[${extraLinesCount}A`);
        }
      }

      // Position cursor correctly on arrow line
      const arrowVisualLen = stripAnsi(arrow).length;
      const targetCol = arrowVisualLen + cursorPos + 1;
      process.stdout.write(`\r\x1b[${targetCol}G`);

      lastRenderedExtraLines = extraLinesCount;
    };

    const cleanupAndResolve = (result) => {
      // Clear dropdown lines below
      process.stdout.write('\r\x1b[K');
      process.stdout.write(arrow + result + '\n');
      process.stdout.write('\x1b[J'); // wipe any leftover dropdown lines below

      process.stdin.removeListener('keypress', onKeypress);
      if (!wasRaw) {
        process.stdin.setRawMode(false);
      }
      resolve(result);
    };

    const onKeypress = (str, key) => {
      // Ctrl+C: Cancel / Exit
      if (key && key.ctrl && key.name === 'c') {
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
        // If user typed only '/' or partial command and there is a match selected
        if (isSlash && matches.length > 0 && buffer === query) {
          const chosen = matches[selectedIdx];
          if (chosen) {
            if (!chosen.needsArg) {
              cleanupAndResolve(chosen.cmd);
              return;
            } else {
              buffer = chosen.cmd + ' ';
              cursorPos = buffer.length;
              selectedIdx = 0;
              render();
              return;
            }
          }
        }
        cleanupAndResolve(buffer.trim());
        return;
      }

      // Tab key: Autocomplete
      if (key && key.name === 'tab') {
        if (isSlash && matches.length > 0) {
          const chosen = matches[selectedIdx];
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
        selectedIdx = 0;
        render();
        return;
      }

      // Arrow Up
      if (key && key.name === 'up') {
        if (isSlash && matches.length > 0) {
          selectedIdx = selectedIdx > 0 ? selectedIdx - 1 : matches.length - 1;
          render();
          return;
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
          selectedIdx = selectedIdx < matches.length - 1 ? selectedIdx + 1 : 0;
          render();
          return;
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
          selectedIdx = 0;
          render();
        }
        return;
      }

      // Printable character
      if (str && str.length === 1 && !key.ctrl && !key.meta) {
        buffer = buffer.slice(0, cursorPos) + str + buffer.slice(cursorPos);
        cursorPos++;
        selectedIdx = 0;
        render();
        return;
      }
    };

    process.stdin.on('keypress', onKeypress);
    render();
  });
}
