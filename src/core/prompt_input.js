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
    let hasDrawnHint = false;

    readline.emitKeypressEvents(process.stdin);
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();

    if (header) {
      process.stdout.write(header);
    }

    const render = () => {
      const arrowVisualLen = stripAnsi(arrow).length;
      const targetCol = arrowVisualLen + cursorPos + 1;

      // 1. Draw prompt line
      process.stdout.write('\r\x1b[K' + arrow + buffer);

      // 2. Check slash commands
      const isSlash = buffer.startsWith('/');
      let hintLine = '';

      if (isSlash) {
        const query = buffer.trim().toLowerCase().split(/\s+/)[0];
        const matches = COMMANDS_REGISTRY.filter((c) => c.cmd.toLowerCase().startsWith(query));

        if (matches.length > 0) {
          const visibleChips = matches.slice(0, 6).map((m, idx) => {
            const isHighlighted = tabCycleIdx >= 0 && (tabCycleIdx % matches.length) === idx;
            if (isHighlighted) {
              return `${c.cyan}${c.bold}[${m.cmd}]${c.reset}`;
            }
            return `${c.dim}${m.cmd}${c.reset}`;
          }).join('  ');

          const more = matches.length > 6 ? ` ${c.dim}+${matches.length - 6} more${c.reset}` : '';
          hintLine = `  ${c.cyan}✦${c.reset} ${visibleChips}${more} ${c.dim}• [Tab] cycle • [Enter] select${c.reset}`;
        } else {
          hintLine = `  ${c.amber}✦ No command match for "${query}"${c.reset} ${c.dim}(press [Enter] for menu)${c.reset}`;
        }
      }

      // Always clear line below and write hint (or empty line)
      process.stdout.write('\n\x1b[K' + hintLine);
      hasDrawnHint = true;

      // Move cursor back up to arrow line and set column
      process.stdout.write(`\x1b[1A\r\x1b[${targetCol}G`);
    };

    const cleanupAndResolve = (result) => {
      if (hasDrawnHint) {
        process.stdout.write('\n\x1b[K\x1b[1A');
      }
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
        if (hasDrawnHint) process.stdout.write('\n\x1b[K\x1b[1A');
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
