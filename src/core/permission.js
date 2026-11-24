import fs from 'node:fs';
import path from 'node:path';

export function assertPathWithinCwd(targetPath, cwd = process.cwd()) {
  if (!targetPath || typeof targetPath !== 'string') {
    throw new Error('Path must be a non-empty string.');
  }

  const resolvedCwd = path.resolve(cwd);
  const resolvedTarget = path.resolve(resolvedCwd, targetPath);
  const isOutside = (root, candidate) => {
    const relative = path.relative(root, candidate);
    return relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative);
  };

  if (isOutside(resolvedCwd, resolvedTarget)) {
    throw new Error(`Access denied: Path "${targetPath}" resolves outside working directory ("${resolvedCwd}").`);
  }

  // Resolve the closest existing ancestor, including symlinked parent directories
  // when the destination file or its final directories do not exist yet.
  const realCwd = fs.realpathSync(resolvedCwd);
  let existingAncestor = resolvedTarget;
  while (true) {
    try {
      fs.lstatSync(existingAncestor);
      break;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) throw error;
      existingAncestor = parent;
    }
  }

  const realAncestor = fs.realpathSync(existingAncestor);
  const canonicalTarget = path.resolve(realAncestor, path.relative(existingAncestor, resolvedTarget));
  if (isOutside(realCwd, canonicalTarget)) {
    throw new Error(`Access denied: Symlink resolves outside working directory ("${realCwd}").`);
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
      { pattern: '^(?:git\\s+(?:status|diff|log|branch)(?:\\s+[\\w./:-]+)*|npm\\s+test|node\\s+--test)$', action: 'allow' },
      { pattern: '^sudo\\b', action: 'deny' },
      { pattern: '^(?:shutdown|reboot|poweroff|mkfs(?:\\.|\\s)|fdisk\\b|parted\\b)', action: 'deny' },
      { pattern: '^rm\\b', action: 'ask' },
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
    const registeredTool = ctx.registry?.get(toolName);
    const extensionTool = registeredTool?.source === 'plugin' || registeredTool?.source === 'mcp';

    // Extension side effects are unknown, so they are not allowed in read-only plan mode.
    if (ctx.mode === 'plan' && extensionTool) {
      return {
        action: 'deny',
        reason: `Extension tool "${toolName}" is disabled in plan mode because its side effects are not known.`
      };
    }

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
        const hasShellOperators = /[;&|<>\x60$\r\n]/.test(cmd);
        const isSafeRead = !hasShellOperators &&
          /^(git\s+(?:status|diff|log|branch)|dir|ls\b|cat\b)/.test(cmd);
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
      if (/[;&|<>\x60$\r\n]/.test(cmd)) {
        return {
          action: 'ask',
          reason: 'Shell operators, substitutions, and redirections require explicit approval.'
        };
      }
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

    const defaultAction = extensionTool || ['write_file', 'edit_file', 'bash'].includes(toolName) ? 'ask' : 'allow';
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
