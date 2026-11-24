import fs from 'node:fs/promises';
import path from 'node:path';
import { exec } from 'node:child_process';
import { assertPathWithinCwd } from '../core/permission.js';

const IGNORED_DIRS = new Set(['node_modules', '.git', '.cache', 'dist', 'build']);
const MAX_OUTPUT_LENGTH = 8000;

/**
 * Check if a binary command is available in PATH.
 * @param {string} cmd - Command name (e.g., 'rg', 'tsc')
 * @returns {Promise<boolean>} true if available
 */
function isBinaryAvailable(cmd) {
  return new Promise((resolve) => {
    exec(`where ${cmd} 2>nul`, { windowsHide: true }, (err, stdout) => {
      resolve(!err && stdout.trim().length > 0);
    });
  });
}

/**
 * Execute a command and return its output.
 * @param {string} cmd - Command to run
 * @param {string} cwd - Working directory
 * @returns {Promise<{stdout, stderr, exitCode}>}
 */
function execCommand(cmd, cwd) {
  return new Promise((resolve) => {
    exec(cmd, { cwd, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        stdout: stdout || '',
        stderr: stderr || '',
        exitCode: err ? err.code || 1 : 0
      });
    });
  });
}

/**
 * Find files respecting .gitignore using ripgrep or fallback.
 * @param {string} baseDir - Base directory
 * @param {string} pattern - Glob pattern
 * @returns {Promise<string[]>} Array of relative file paths
 */
async function findFilesWithRipgrep(baseDir, pattern) {
  // Check if ripgrep is available
  const hasRg = await isBinaryAvailable('rg');
  
  if (hasRg) {
    // Use ripgrep to find files, respecting .gitignore
    const { stdout } = await execCommand(
      `rg --files --glob "${pattern}"`,
      baseDir
    );
    return stdout.trim().split(/\r?\n/).filter(Boolean).map(p => p.replace(/\\/g, '/'));
  }
  
  // Fallback: manual file finding (respects basic ignored dirs)
  const files = [];
  async function walk(dir) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORED_DIRS.has(entry.name)) {
            await walk(fullPath);
          }
        } else if (entry.isFile()) {
          const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
          // Simple glob matching
          if (matchGlob(relPath, pattern)) {
            files.push(relPath);
          }
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }
  
  await walk(baseDir);
  return files;
}

/**
 * Simple glob matching (supports *, **, ?)
 */
function matchGlob(filePath, pattern) {
  // Handle simple patterns like *.js by matching the basename
  if (!pattern.includes('/')) {
    const basename = filePath.split('/').pop();
    const regexStr = pattern
      .replace(/\./g, '\\.')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '.');
    const regex = new RegExp(`^${regexStr}$`);
    return regex.test(basename);
  }
  
  // Convert glob pattern to regex
  let regexStr = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.');
  
  const regex = new RegExp(`^${regexStr}$`);
  return regex.test(filePath);
}

/**
 * Run LSP diagnostics on a file if available.
 * @param {string} filePath - Absolute path to file
 * @param {string} baseDir - Base working directory
 * @returns {Promise<string|null>} Diagnostics output or null if no LSP available
 */
async function runLSPDiagnostics(filePath, baseDir) {
  const ext = path.extname(filePath).toLowerCase();
  const diagnostics = [];
  
  // TypeScript/JavaScript files - try tsc
  if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
    const hasTsc = await isBinaryAvailable('tsc');
    if (hasTsc) {
      const { stdout, stderr, exitCode } = await execCommand(
        `tsc --noEmit --strict false "${filePath}" 2>&1`,
        baseDir
      );
      if (exitCode !== 0 || stderr) {
        diagnostics.push(`TypeScript diagnostics (tsc):\n${stdout || stderr}`);
      }
    }
  }
  
  // Python files - try pyright
  if (ext === '.py') {
    const hasPyright = await isBinaryAvailable('pyright');
    if (hasPyright) {
      const { stdout, stderr, exitCode } = await execCommand(
        `pyright "${filePath}" 2>&1`,
        baseDir
      );
      if (exitCode !== 0 || stderr) {
        diagnostics.push(`Python diagnostics (pyright):\n${stdout || stderr}`);
      }
    }
  }
  
  if (diagnostics.length === 0) {
    return null;
  }
  
  return diagnostics.join('\n\n');
}

/**
 * Grep tool with ripgrep support and .gitignore respect.
 */
export const grepTool = {
  name: 'grep',
  description: 'Search for text or regex pattern across files. Uses ripgrep if available (respects .gitignore), falls back to built-in grep.',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Regular expression or text pattern to search for'
      },
      path: {
        type: 'string',
        description: 'Target directory or file path (defaults to current directory)'
      },
      include: {
        type: 'string',
        description: 'Glob pattern to filter files (e.g., "*.js", "*.ts")'
      }
    },
    required: ['pattern']
  },
  async execute({ pattern, path: targetPath = '.', include }, ctx = {}) {
    if (!pattern) {
      return 'Error: "pattern" argument is required.';
    }

    const baseDir = ctx.cwd || process.cwd();
    let resolvedTarget;
    try {
      resolvedTarget = assertPathWithinCwd(targetPath, baseDir);
    } catch (err) {
      return `Error accessing path "${targetPath}": ${err.message}`;
    }

    const hasRg = await isBinaryAvailable('rg');

    if (hasRg) {
      // Use ripgrep for fast, gitignore-aware search
      let rgCmd = `rg --line-number --no-heading --color never "${pattern}"`;
      if (include) {
        rgCmd += ` --glob "${include}"`;
      }
      rgCmd += ` "${resolvedTarget}"`;
      
      const { stdout, stderr, exitCode } = await execCommand(rgCmd, baseDir);
      
      if (exitCode === 1) {
        return `No matches found for pattern "${pattern}".`;
      }
      if (exitCode !== 0 && !stdout) {
        return `Error running ripgrep: ${stderr || 'Unknown error'}`;
      }
      
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      if (lines.length > 200) {
        lines.splice(200);
        lines.push('... (results capped at 200 lines)');
      }
      
      return lines.join('\n') || `No matches found for pattern "${pattern}".`;
    }

    // Fallback: built-in grep
    let regex;
    try {
      regex = new RegExp(pattern);
    } catch {
      regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    }

    let candidateFiles = [];
    try {
      const stat = await fs.stat(resolvedTarget);
      if (stat.isFile()) {
        candidateFiles = [resolvedTarget];
      } else if (stat.isDirectory()) {
        candidateFiles = await findFilesWithRipgrep(baseDir, include || '**/*');
      }
    } catch (err) {
      return `Error accessing path "${targetPath}": ${err.message}`;
    }

    const matches = [];
    for (const filePath of candidateFiles) {
      try {
        const content = await fs.readFile(filePath, 'utf8');
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            const relPath = path.relative(baseDir, filePath).replace(/\\/g, '/');
            matches.push(`${relPath}:${i + 1}: ${lines[i]}`);
            if (matches.length >= 200) {
              matches.push('... (matched more than 200 lines, results capped)');
              return matches.join('\n');
            }
          }
        }
      } catch {
        // Skip unreadable / binary files
      }
    }

    if (matches.length === 0) {
      return `No matches found for pattern "${pattern}".`;
    }

    return matches.join('\n');
  }
};

/**
 * Run diagnostics after write/edit and append to result.
 * @param {string} filePath - Absolute path to file
 * @param {string} baseDir - Base working directory
 * @returns {Promise<string>} Diagnostic output or empty string
 */
export async function runDiagnostics(filePath, baseDir) {
  const diagnostics = await runLSPDiagnostics(filePath, baseDir);
  if (diagnostics) {
    return `\n\n--- LSP Diagnostics ---\n${diagnostics}`;
  }
  return '';
}

export { runLSPDiagnostics, isBinaryAvailable };