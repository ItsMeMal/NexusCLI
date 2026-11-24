import fs from 'node:fs/promises';
import path from 'node:path';
import { assertPathWithinCwd } from '../core/permission.js';

const IGNORED_DIRS = new Set(['node_modules', '.git', '.cache', 'dist', 'build', '.next']);

function globToRegExp(globPattern) {
  const normalized = globPattern.replace(/\\/g, '/');
  let regStr = '^';
  let i = 0;

  while (i < normalized.length) {
    const c = normalized[i];

    if (c === '*' && normalized[i + 1] === '*') {
      if (normalized[i + 2] === '/') {
        regStr += '(?:.+/)?';
        i += 3;
      } else {
        regStr += '.*';
        i += 2;
      }
    } else if (c === '*') {
      regStr += '[^/]*';
      i++;
    } else if (c === '?') {
      regStr += '[^/]';
      i++;
    } else if ('./+^$[](){}|'.includes(c)) {
      regStr += '\\' + c;
      i++;
    } else {
      regStr += c;
      i++;
    }
  }

  regStr += '$';
  return new RegExp(regStr);
}

async function collectFiles(currentDir, rootDir) {
  let entries = [];
  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        const sub = await collectFiles(path.join(currentDir, entry.name), rootDir);
        results.push(...sub);
      }
    } else if (entry.isFile()) {
      results.push(path.join(currentDir, entry.name));
    }
  }
  return results;
}

export const globTool = {
  name: 'glob',
  description: 'Search file paths using a glob pattern (e.g. "**/*.js", "src/**/*.js", "*.json").',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern to match file paths'
      },
      path: {
        type: 'string',
        description: 'Base directory to search in (defaults to current working directory)'
      }
    },
    required: ['pattern']
  },
  async execute({ pattern, path: targetDir = '.' }, ctx = {}) {
    if (!pattern) {
      return 'Error: "pattern" argument is required.';
    }

    let baseDir;
    try {
      baseDir = assertPathWithinCwd(targetDir, ctx.cwd || process.cwd());
    } catch (err) {
      return `Error accessing path "${targetDir}": ${err.message}`;
    }

    try {
      const stat = await fs.stat(baseDir);
      if (!stat.isDirectory()) {
        return `Error: Base path "${targetDir}" is not a directory.`;
      }
    } catch (err) {
      return `Error accessing path "${targetDir}": ${err.message}`;
    }

    const allFiles = await collectFiles(baseDir, baseDir);
    const regex = globToRegExp(pattern);

    const matches = [];
    for (const file of allFiles) {
      const relPath = path.relative(baseDir, file).replace(/\\/g, '/');
      if (regex.test(relPath) || regex.test(path.basename(relPath))) {
        matches.push(relPath);
      }
    }

    if (matches.length === 0) {
      return `No files matched glob pattern "${pattern}".`;
    }

    matches.sort();
    return matches.join('\n');
  }
};
