import fs from 'node:fs/promises';
import { assertPathWithinCwd } from '../core/permission.js';

export const readFileTool = {
  name: 'read_file',
  description: 'Read content of a file at the specified path',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative or absolute file path to read'
      }
    },
    required: ['path']
  },
  async execute({ path: targetPath }, ctx = {}) {
    if (!targetPath) {
      return 'Error: "path" argument is required.';
    }

    try {
      const resolvedPath = assertPathWithinCwd(targetPath, ctx.cwd || process.cwd());
      const content = await fs.readFile(resolvedPath, 'utf8');
      return content;
    } catch (err) {
      return `Error reading file "${targetPath}": ${err.message}`;
    }
  }
};
