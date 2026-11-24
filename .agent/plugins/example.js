// Example plugin: registers a simple tool and a before_tool hook.
export default function plugin(ctx) {
  const { registry, hooks, workingDir } = ctx;

  // Register a custom tool
  registry.register({
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

  // Hook: log before tool execution
  hooks.before_tool.push(async ({ tool, args }) => {
    // Example: could modify args or block. Here we just observe.
    console.error(`[plugin] before_tool: ${tool}`);
  });

  console.error('[plugin] example plugin loaded from', workingDir);
}