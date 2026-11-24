import { McpManager } from './mcp.js';
import { PluginManager } from './plugin.js';
import { CommandManager } from './command.js';

export class ExtensionManager {
  constructor(workingDir = process.cwd(), options = {}) {
    this.workingDir = workingDir;
    this.mcp = options.mcpManager || new McpManager(workingDir, options.mcpOptions);
    this.plugins = options.pluginManager || new PluginManager(workingDir);
    this.commands = new CommandManager(workingDir);
    this.initialized = false;
    this.initializationResult = null;
  }

  async initialize(registry) {
    if (this.initialized) return this.initializationResult;
    this.commands.loadCommands();
    const pluginResults = await this.plugins.loadPlugins(registry);
    const mcpResults = await this.mcp.connectAll(registry);
    this.initializationResult = {
      plugins: pluginResults,
      mcp: mcpResults,
      commands: this.commands.listCommands()
    };
    this.initialized = true;
    return this.initializationResult;
  }

  async shutdown() {
    await this.mcp.disconnectAll();
    this.initialized = false;
    this.initializationResult = null;
  }
}

export default ExtensionManager;
