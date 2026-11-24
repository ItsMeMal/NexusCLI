import fs from 'node:fs/promises';
import path from 'node:path';
import { assertPathWithinCwd } from '../core/permission.js';
import { runDiagnostics } from './grep.js';

export const writeFileTool = {
  name: 'write_file',
  description: 'Write content to a file. Overwrites existing file and creates directories if needed. Runs LSP diagnostics after write.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Target file path'
      },
      content: {
        type: 'string',
        description: 'Text content to write into the file'
      }
    },
    required: ['path', 'content']
  },
  async execute({ path: targetPath, content }, ctx = {}) {
    if (!targetPath) {
      return 'Error: "path" argument is required.';
    }
    if (content === undefined || content === null) {
      return 'Error: "content" argument is required.';
    }

    try {
      const resolvedPath = assertPathWithinCwd(targetPath, ctx.cwd || process.cwd());
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
      await fs.writeFile(resolvedPath, content, 'utf8');
      
      // Run LSP diagnostics after write
      const baseDir = ctx.cwd || process.cwd();
      const diagnostics = await runDiagnostics(resolvedPath, baseDir);
      
      return `File successfully written: ${targetPath}${diagnostics}`;
    } catch (err) {
      return `Error writing file "${targetPath}": ${err.message}`;
    }
  }
};
