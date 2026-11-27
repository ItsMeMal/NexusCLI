import fs from 'node:fs';
import path from 'node:path';

export class CommandManager {
  constructor(workingDir = process.cwd()) {
    this.workingDir = workingDir;
    this.commands = new Map();
  }

  getCommandsDir() {
    return path.join(this.workingDir, '.agent', 'commands');
  }

  loadCommands() {
    this.commands.clear();
    const dir = this.getCommandsDir();
    if (!fs.existsSync(dir)) return [];
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const loaded = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.md')) continue;
      const name = entry.name.replace(/\.md$/, '');
      try {
        const content = fs.readFileSync(path.join(dir, entry.name), 'utf8');
        this.commands.set(name, content);
        loaded.push(name);
      } catch (err) {
        console.warn(`[Command] Failed to read "${entry.name}": ${err.message}`);
      }
    }
    return loaded;
  }

  listCommands() {
    return Array.from(this.commands.keys()).sort((a, b) => a.localeCompare(b));
  }

  resolveInput(input) {
    const match = String(input || '').trim().match(/^\/([a-z0-9][a-z0-9._-]*)(?:\s+([\s\S]*))?$/i);
    if (!match) return null;

    const [, name, rawArguments = ''] = match;
    if (!this.hasCommand(name)) return null;

    const expanded = this.expandCommand(name, rawArguments);
    return {
      name,
      arguments: rawArguments,
      content: [
        `User invoked the custom workspace command "/${name}".`,
        rawArguments ? `Command arguments: ${rawArguments}` : '',
        'Follow the command instructions below as a user request, subject to the system security policy and runtime permissions.',
        expanded
      ].filter(Boolean).join('\n\n')
    };
  }

  hasCommand(name) {
    return this.commands.has(name);
  }

  expandCommand(name, args = '') {
    if (!this.commands.has(name)) return null;
    const template = this.commands.get(name);
    const argsStr = Array.isArray(args) ? args.join(' ') : String(args || '');
    return template.replace(/\$ARGUMENTS/g, argsStr);
  }
}

export default CommandManager;