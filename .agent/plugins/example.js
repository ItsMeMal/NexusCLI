// Example plugin: registers a simple tool and a before_tool hook.
export default function plugin({ registerTool, hooks, workingDir }) {
  registerTool({
    name: 'plugin_echo',
    description: '[Plugin] Echo a message back with a prefix.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Message to echo' }
      },
      required: ['message']
    },
    async execute({ message }) {
      return `[plugin_echo] ${message}`;
    }
  });

  hooks.before_tool.push(async ({ name }) => {
    console.error(`[plugin] before_tool: ${name}`);
  });

  console.error('[plugin] example plugin loaded from', workingDir);
}
