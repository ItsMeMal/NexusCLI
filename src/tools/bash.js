import { executeBash } from '../core/sandbox.js';

export const bashTool = {
  name: 'bash',
  description: 'Execute a shell command in the workspace directory. Supports optional Docker sandbox.',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The command string to execute'
      }
    },
    required: ['command']
  },
  async execute({ command }, ctx = {}) {
    if (!command) {
      return 'Error: "command" argument is required.';
    }
    return executeBash(command, ctx);
  }
};