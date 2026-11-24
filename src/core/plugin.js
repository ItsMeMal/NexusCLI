import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HOOK_NAMES = ['before_tool', 'after_tool', 'on_message'];

export class PluginManager {
  constructor(workingDir = process.cwd()) {
    this.workingDir = workingDir;
    this.hooks = Object.fromEntries(HOOK_NAMES.map(name => [name, []]));
    this.loadedPlugins = [];
    this.initialized = false;
    this.loadResult = [];
  }

  getPluginsDir() {
    return path.join(this.workingDir, '.agent', 'plugins');
  }

  async loadPlugins(registry) {
    if (this.initialized) return this.loadResult;
    const dir = this.getPluginsDir();
    if (!fs.existsSync(dir)) {
      this.initialized = true;
      return [];
    }

    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
        .filter(entry => entry.isFile() && /\.m?js$/i.test(entry.name))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      this.initialized = true;
      return [{ ok: false, error: err.message }];
    }

    const results = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      try {
        const mod = await import(pathToFileURL(fullPath).href);
        const plugin = mod.default || mod;
        const registerTool = (tool) => {
          if (!tool || typeof tool !== 'object') {
            throw new Error('registerTool expects a tool definition object.');
          }
          if (registry.has(tool.name)) {
            throw new Error(`Tool "${tool.name}" is already registered and cannot be replaced by a plugin.`);
          }
          registry.register({ ...tool, source: tool.source || 'plugin' });
        };
        const ctx = {
          registry,
          hooks: this.hooks,
          workingDir: this.workingDir,
          registerTool,
          on: (name, handler) => {
            if (!HOOK_NAMES.includes(name)) throw new Error(`Unknown plugin hook "${name}".`);
            if (typeof handler !== 'function') throw new Error(`Hook "${name}" must be a function.`);
            this.hooks[name].push(handler);
          }
        };

        if (typeof plugin === 'function') {
          await plugin(ctx);
        } else if (plugin && typeof plugin.register === 'function') {
          await plugin.register(ctx);
        } else if (plugin && typeof plugin.init === 'function') {
          await plugin.init(ctx);
        }

        if (plugin && plugin.hooks) {
          for (const name of HOOK_NAMES) {
            if (Array.isArray(plugin.hooks[name])) {
              this.hooks[name].push(...plugin.hooks[name].filter(fn => typeof fn === 'function'));
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

    this.initialized = true;
    this.loadResult = results;
    return results;
  }

  async runHook(name, payload) {
    const handlers = this.hooks[name] || [];
    for (const handler of handlers) {
      try {
        await handler(payload);
      } catch (err) {
        console.warn(`[Plugin hook ${name}] ${err.message}`);
      }
    }
  }
}

export default PluginManager;
