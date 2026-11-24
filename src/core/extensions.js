import { McpManager } from './mcp.js';
import { PluginManager } from './plugin.js';
import { CommandManager } from './command.js';

export class ExtensionManager {
  constructor(workingDir = process.cwd()) {
    this.workingDir = workingDir;
    this.mcp = new McpManager(workingDir);
    this.plugins = new PluginManager(workingDir);
    this.commands = new CommandManager(workingDir);
  }

  async initialize(registry) {
    this.commands.loadCommands();
    const pluginResults = await this.plugins.loadPlugins(registry);
    const mcpResults = await this.mcp.connectAll(registry);
    return { plugins: pluginResults, mcp: mcpResults, commands: this.commands.listCommands() };
  }

  async shutdown() {
    await this.mcp.disconnectAll();
  }
}

export default ExtensionManager;