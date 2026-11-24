const MAX_OUTPUT_LENGTH = 8000;

export class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  register(tool) {
    if (!tool || !tool.name || typeof tool.execute !== 'function') {
      throw new Error('Tool must have a name and an execute function.');
    }
    this.tools.set(tool.name, tool);
  }

  get(name) {
    return this.tools.get(name);
  }

  has(name) {
    return this.tools.has(name);
  }

  unregister(name) {
    return this.tools.delete(name);
  }

  list() {
    return Array.from(this.tools.values());
  }

  getDefinitions() {
    return Array.from(this.tools.values()).map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.parameters || { type: 'object', properties: {} }
      }
    }));
  }

  async execute(name, rawArgs, ctx = {}) {
    const tool = this.tools.get(name);
    if (!tool) {
      return `Error: Unknown tool "${name}". Available tools: ${Array.from(this.tools.keys()).join(', ')}`;
    }

    let parsedArgs = rawArgs;
    if (typeof rawArgs === 'string') {
      try {
        parsedArgs = JSON.parse(rawArgs);
      } catch (err) {
        return `Error: Invalid JSON arguments for tool "${name}": ${err.message}. Received: ${rawArgs}`;
      }
    }

    try {
      const output = await tool.execute(parsedArgs || {}, ctx);
      return this.truncateOutput(String(output ?? ''));
    } catch (err) {
      return `Error executing tool "${name}": ${err.message}`;
    }
  }

  truncateOutput(text, maxLength = MAX_OUTPUT_LENGTH) {
    if (text.length <= maxLength) {
      return text;
    }
    const truncatedCount = text.length - maxLength;
    return `${text.slice(0, maxLength)}\n\n[dipotong: sisa ${truncatedCount} karakter diabaikan untuk keamanan konteks]`;
  }
}

export { MAX_OUTPUT_LENGTH };