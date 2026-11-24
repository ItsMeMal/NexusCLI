import fs from 'node:fs';
import path from 'node:path';

export function assertPathWithinCwd(targetPath, cwd = process.cwd()) {
  if (!targetPath || typeof targetPath !== 'string') {
    throw new Error('Path must be a non-empty string.');
  }

  const resolvedCwd = path.resolve(cwd);
  const resolvedTarget = path.resolve(resolvedCwd, targetPath);

  // Check relative path navigation outside root
  const rel = path.relative(resolvedCwd, resolvedTarget);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Access denied: Path "${targetPath}" resolves outside working directory ("${resolvedCwd}").`);
  }

  // Check canonical symlink escape if file or directory exists
  try {
    if (fs.existsSync(resolvedTarget)) {
      const realTarget = fs.realpathSync(resolvedTarget);
      const realCwd = fs.realpathSync(resolvedCwd);
      const realRel = path.relative(realCwd, realTarget);
      if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
        throw new Error(`Access denied: Symlink resolves outside working directory ("${realCwd}").`);
      }
    }
  } catch (err) {
    if (err.message.startsWith('Access denied:')) throw err;
  }

  return resolvedTarget;
}

export class PermissionManager {
  constructor(config = {}) {
    this.tools = {
      read_file: 'allow',
      grep: 'allow',
      glob: 'allow',
      write_file: 'ask',
      edit_file: 'ask',
      bash: 'ask',
      ...(config.tools || {})
    };

    this.bashRules = [
      { pattern: '^git\\s+(status|diff|log|branch)', action: 'allow' },
      { pattern: '^(npm|node)\\s+--test', action: 'allow' },
      { pattern: '^npm\\s+test', action: 'allow' },
      { pattern: '^rm\\b', action: 'ask' },
      { pattern: '^sudo\\b', action: 'deny' },
      ...(config.bash || [])
    ];
  }

  static fromConfigFile(workingDir = process.cwd()) {
    const configPath = path.resolve(workingDir, 'agent.config.json');
    let fileConfig = {};

    if (fs.existsSync(configPath)) {
      try {
        const raw = fs.readFileSync(configPath, 'utf8');
        const parsed = JSON.parse(raw);
        fileConfig = parsed.permissions || {};
      } catch (err) {
        console.warn(`Warning: Failed to parse agent.config.json: ${err.message}`);
      }
    }

    return new PermissionManager(fileConfig);
  }

  evaluate(toolName, args = {}, ctx = {}) {
    // Plan mode (read-only) enforcement
    if (ctx.mode === 'plan') {
      if (toolName === 'write_file' || toolName === 'edit_file') {
        return {
          action: 'deny',
          reason: `Tool "${toolName}" is blocked in plan mode (read-only). Switch to /build to allow writing.`
        };
      }
      if (toolName === 'bash') {
        const cmd = (args.command || '').trim();
        const isSafeRead = /^(git\s+(status|diff|log|branch)|dir|ls\b|cat\b)/.test(cmd);
        if (!isSafeRead) {
          return {
            action: 'deny',
            reason: `Bash command "${cmd}" is blocked in plan mode (read-only). Switch to /build to execute.`
          };
        }
      }
    }

    // Prompt-injection mitigation: if untrusted external content was read
    // earlier in this session, dangerous tools require explicit confirmation.
    if (ctx && ctx.externalContentRead && ['bash', 'write_file', 'edit_file', 'task'].includes(toolName)) {
      if (this.tools[toolName] !== 'deny') {
        return {
          action: 'ask',
          reason: `Dangerous tool "${toolName}" triggered after reading untrusted external content; confirmation required.`
        };
      }
    }

    if (toolName === 'bash') {
      const cmd = (args.command || '').trim();
      for (const rule of this.bashRules) {
        try {
          const reg = new RegExp(rule.pattern);
          if (reg.test(cmd)) {
            return {
              action: rule.action,
              reason: `Matched bash rule pattern: ${rule.pattern}`
            };
          }
        } catch {
          // Skip invalid regex
        }
      }
      return {
        action: this.tools.bash || 'ask',
        reason: 'Default bash tool permission'
      };
    }

    const defaultAction = ['write_file', 'edit_file', 'bash'].includes(toolName) ? 'ask' : 'allow';
    const action = this.tools[toolName] || defaultAction;
    return {
      action,
      reason: `Tool permission for ${toolName}`
    };
  }

  async authorize(toolName, args = {}, ctx = {}) {
    const { action, reason } = this.evaluate(toolName, args, ctx);

    if (action === 'deny') {
      return {
        allowed: false,
        error: `Permission denied: Action explicitly blocked by policy (${reason}).`
      };
    }

    if (action === 'allow') {
      return { allowed: true };
    }

    // action === 'ask'
    if (typeof ctx.askUser === 'function') {
      const approved = await ctx.askUser({ tool: toolName, args, reason });
      if (approved) {
        return { allowed: true };
      }
      return {
        allowed: false,
        error: `Permission denied: User declined execution of ${toolName}.`
      };
    }

    // If autoApprove flag is set in context (e.g. non-interactive test mode)
    if (ctx.autoApprove) {
      return { allowed: true };
    }

    return {
      allowed: false,
      error: `Permission denied: Execution of "${toolName}" requires user confirmation ("ask").`
    };
  }
}
