import fs from 'node:fs/promises';
import path from 'node:path';
import { assertPathWithinCwd } from '../core/permission.js';

const MAX_OUTPUT_LENGTH = 8000;

const IGNORED_DIRS = new Set(['node_modules', '.git', '.cache', 'dist', 'build', '.agent']);
const MAX_FILES_TO_SCAN = 200;

/**
 * Important file patterns (entry points, config, main source files)
 */
const IMPORTANT_PATTERNS = [
  'package.json',
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  'tsconfig.json',
  'jsconfig.json',
  'index.js',
  'index.ts',
  'main.js',
  'main.ts',
  'app.js',
  'app.ts',
  'server.js',
  'server.ts',
  'cli.js',
  'cli.ts',
  'src/index.js',
  'src/main.js',
  'src/server.js',
  'src/cli.js',
  'src/core/index.js',
  'src/tools/index.js'
];

/**
 * File extensions to include in repo map
 */
const SOURCE_EXTENSIONS = new Set([
  '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp',
  '.json', '.yaml', '.yml', '.toml', '.md'
]);

/**
 * Scan directory recursively and build file tree
 */
async function scanDirectory(dirPath, baseDir, depth = 0, maxDepth = 4) {
  if (depth > maxDepth) return null;
  
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return null;
  }

  const result = {
    name: path.basename(dirPath) || dirPath,
    type: 'dir',
    children: []
  };

  // Sort: directories first, then files
  const dirs = [];
  const files = [];
  
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        dirs.push(entry);
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SOURCE_EXTENSIONS.has(ext) || IMPORTANT_PATTERNS.includes(entry.name)) {
        files.push(entry);
      }
    }
  }

  // Process directories first
  for (const dir of dirs) {
    const fullPath = path.join(dirPath, dir.name);
    const child = await scanDirectory(fullPath, baseDir, depth + 1, maxDepth);
    if (child) {
      result.children.push(child);
    }
  }

  // Process files
  for (const file of files) {
    const fullPath = path.join(dirPath, file.name);
    const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
    const stat = await fs.stat(fullPath).catch(() => null);
    
    result.children.push({
      name: file.name,
      type: 'file',
      path: relPath,
      size: stat?.size || 0
    });
  }

  return result;
}

/**
 * Format file tree as readable text
 */
function formatTree(node, prefix = '', isLast = true) {
  if (!node) return '';
  
  const lines = [];
  const connector = isLast ? '└── ' : '├── ';
  const name = node.type === 'dir' ? `${node.name}/` : node.name;
  
  if (node.type === 'dir') {
    lines.push(`${prefix}${connector}${name}`);
    
    const newPrefix = prefix + (isLast ? '    ' : '│   ');
    const children = node.children || [];
    
    for (let i = 0; i < children.length; i++) {
      const isLastChild = i === children.length - 1;
      lines.push(formatTree(children[i], newPrefix, isLastChild));
    }
  } else {
    lines.push(`${prefix}${connector}${name}`);
  }
  
  return lines.join('\n');
}

/**
 * Identify important entry points and config files
 */
function findImportantFiles(tree, baseDir) {
  const important = [];
  
  function walk(node, currentPath = '') {
    if (!node) return;
    
    const fullPath = currentPath ? `${currentPath}/${node.name}` : node.name;
    
    if (node.type === 'file') {
      const basename = node.name;
      const relPath = node.path || fullPath;
      
      if (IMPORTANT_PATTERNS.includes(basename) || 
          IMPORTANT_PATTERNS.includes(relPath)) {
        important.push({ name: basename, path: relPath, type: 'config' });
      }
    } else if (node.type === 'dir') {
      for (const child of node.children || []) {
        walk(child, fullPath);
      }
    }
  }
  
  walk(tree);
  return important;
}

/**
 * Count files by extension
 */
function countByExtension(tree) {
  const counts = {};
  
  function walk(node) {
    if (!node) return;
    if (node.type === 'file') {
      const ext = path.extname(node.name).toLowerCase() || '(no ext)';
      counts[ext] = (counts[ext] || 0) + 1;
    } else if (node.type === 'dir') {
      for (const child of node.children || []) {
        walk(child);
      }
    }
  }
  
  walk(tree);
  return counts;
}

export const repoMapTool = {
  name: 'repo_map',
  description: 'Generate a structural map of the project: important files, entry points, directory tree, and file type counts. Useful for understanding project architecture quickly.',
  parameters: {
    type: 'object',
    properties: {
      maxDepth: {
        type: 'number',
        description: 'Maximum directory depth to scan (default: 4)'
      },
      includeFiles: {
        type: 'boolean',
        description: 'Whether to include file listings (default: true)'
      }
    },
    required: []
  },
  async execute({ maxDepth = 4, includeFiles = true }, ctx = {}) {
    const baseDir = ctx.cwd || process.cwd();
    
    try {
      const tree = await scanDirectory(baseDir, baseDir, 0, maxDepth);
      
      if (!tree) {
        return 'Error: Could not scan directory.';
      }
      
      const importantFiles = findImportantFiles(tree, baseDir);
      const extCounts = countByExtension(tree);
      
      const lines = [];
      lines.push('=== PROJECT REPO MAP ===');
      lines.push(`Base directory: ${baseDir}`);
      lines.push('');
      
      // Important files section
      if (importantFiles.length > 0) {
        lines.push('--- Important Files ---');
        for (const f of importantFiles) {
          lines.push(`  ${f.path}`);
        }
        lines.push('');
      }
      
      // File type counts
      lines.push('--- File Type Counts ---');
      const sortedExts = Object.entries(extCounts).sort((a, b) => b[1] - a[1]);
      for (const [ext, count] of sortedExts.slice(0, 15)) {
        lines.push(`  ${ext}: ${count}`);
      }
      lines.push('');
      
      // Directory tree
      if (includeFiles) {
        lines.push('--- Directory Tree ---');
        lines.push(formatTree(tree));
      }
      
      const output = lines.join('\n');
      
      // Truncate if too long
      if (output.length > MAX_OUTPUT_LENGTH) {
        return output.substring(0, MAX_OUTPUT_LENGTH) + `\n\n... (truncated, full output ${output.length} chars)`;
      }
      
      return output;
    } catch (err) {
      return `Error generating repo map: ${err.message}`;
    }
  }
};