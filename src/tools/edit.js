import fs from 'node:fs/promises';
import { assertPathWithinCwd } from '../core/permission.js';
import { runDiagnostics } from './grep.js';

function findSnippetNearMatch(content, targetStr) {
  const lines = content.split(/\r?\n/);
  const targetWords = targetStr.trim().split(/\s+/).filter(w => w.length > 2);

  let bestLine = -1;
  let maxScore = 0;

  for (let i = 0; i < lines.length; i++) {
    let score = 0;
    for (const word of targetWords) {
      if (lines[i].includes(word)) score++;
    }
    if (score > maxScore) {
      maxScore = score;
      bestLine = i;
    }
  }

  if (bestLine === -1) {
    const previewCount = Math.min(lines.length, 15);
    return lines.slice(0, previewCount).map((l, idx) => `${idx + 1}: ${l}`).join('\n');
  }

  const start = Math.max(0, bestLine - 5);
  const end = Math.min(lines.length, bestLine + 6);
  return lines.slice(start, end).map((l, idx) => `${start + idx + 1}: ${l}`).join('\n');
}

export const editFileTool = {
  name: 'edit_file',
  description: 'Precisely replace old_str with new_str in a target file. old_str must uniquely match exactly one location in the file.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative or absolute file path to edit'
      },
      old_str: {
        type: 'string',
        description: 'Exact text segment to find and replace'
      },
      new_str: {
        type: 'string',
        description: 'New text segment to replace old_str with'
      }
    },
    required: ['path', 'old_str', 'new_str']
  },
  async execute({ path: targetPath, old_str, new_str }, ctx = {}) {
    if (!targetPath) {
      return 'Error: "path" argument is required.';
    }
    if (old_str === undefined || old_str === null) {
      return 'Error: "old_str" argument is required.';
    }
    if (new_str === undefined || new_str === null) {
      return 'Error: "new_str" argument is required.';
    }
    if (old_str === new_str) {
      return 'Error: "old_str" and "new_str" are identical. No edit needed.';
    }

    let resolvedPath;
    try {
      resolvedPath = assertPathWithinCwd(targetPath, ctx.cwd || process.cwd());
    } catch (err) {
      return `Error editing file "${targetPath}": ${err.message}`;
    }

    let content;
    try {
      content = await fs.readFile(resolvedPath, 'utf8');
    } catch (err) {
      return `Error reading file "${targetPath}": ${err.message}`;
    }

    let occurrences = 0;
    let searchPos = 0;
    while ((searchPos = content.indexOf(old_str, searchPos)) !== -1) {
      occurrences++;
      searchPos += old_str.length;
    }

    if (occurrences === 0) {
      const snippet = findSnippetNearMatch(content, old_str);
      return `Error: old_str not found in "${targetPath}". Ensure exact whitespace, indentation, and casing.
Relevant file snippet around closest match:
---
${snippet}
---`;
    }

    if (occurrences > 1) {
      return `Error: old_str found ${occurrences} times in "${targetPath}". old_str must be unique. Add more surrounding context lines to disambiguate the target section.`;
    }

    const updatedContent = content.replace(old_str, new_str);

    try {
      await fs.writeFile(resolvedPath, updatedContent, 'utf8');
      
      // Run LSP diagnostics after edit
      const baseDir = ctx.cwd || process.cwd();
      const diagnostics = await runDiagnostics(resolvedPath, baseDir);
      
      return `File "${targetPath}" successfully edited.${diagnostics}`;
    } catch (err) {
      return `Error writing file "${targetPath}": ${err.message}`;
    }
  }
};
