import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export class PluginManager {
  constructor(workingDir = process.cwd()) {
    this.workingDir = workingDir;
    this.hooks = {
      before_tool: [],
      after_tool: [],
      on_message: []
    };
    this.loadedPlugins = [];
  }

  getPluginsDir() {
    return path.join(this.workingDir, '.agent', 'plugins');
  }

  async loadPlugins(registry) {
    const dir = this.getPluginsDir();
    if (!fs.existsSync(dir)) return [];
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const results = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.js') && !entry.name.endsWith('.mjs')) continue;
      const fullPath = path.join(dir, entry.name);
      try {
        const mod = await import(pathToFileURL(fullPath).href);
        const plugin = mod.default || mod;
        const ctx = {
          registry,
          hooks: this.hooks,
          workingDir: this.workingDir,
          registerTool: (tool) => registry.register(tool)
        };
        if (typeof plugin === 'function') {
          await plugin(ctx);
        } else if (plugin && typeof plugin.register === 'function') {
          await plugin.register(ctx);
        } else if (plugin && typeof plugin.init === 'function') {
          await plugin.init(ctx);
        }
        // Allow plugin to declare hooks object
        if (plugin && plugin.hooks) {
          for (const key of Object.keys(this.hooks)) {
            if (Array.isArray(plugin.hooks[key])) {
              this.hooks[key].push(...plugin.hooks[key]);
            }
          }
        }
        this.loadedPlugins.push(entry.name);
        results.push({ file: entry.name, ok: true });
      } catch (err) {
        results.push({ file: entry.name, ok: false, error: err.message });
        console.warn(`[Plugin] Failed to load "${entry.name}": ${err.message}`);
      }
    }
    return results;
  }

  async runHook(name, payload) {
    const fns = this.hooks[name] || [];
    for (const fn of fns) {
      try {
        await fn(payload);
      } catch (err) {
        console.warn(`[Plugin hook ${name}] ${err.message}`);
      }
    }
  }
}

export default PluginManager;