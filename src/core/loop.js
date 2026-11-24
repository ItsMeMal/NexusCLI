import { chat as defaultChat } from './llm.js';
import { compactContextIfNeeded, calculateContextUsage, pruneOldOutputs, formatUsageDescription } from './context.js';
import { defaultRegistry } from '../tools/index.js';
import { PermissionManager } from './permission.js';
import { SessionSnapshotManager } from './snapshot.js';
import { isUntrustedTool, wrapUntrusted } from './injection.js';
import { appendAuditEntry } from './audit.js';
import { redactSecrets } from './secrets.js';

export const MAX_STEPS = 25;

function canonicalize(obj) {
  if (obj === null || typeof obj !== 'object') {
    return String(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalize).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

export async function runAgentLoop({
  messages = [],
  registry = defaultRegistry,
  chatFn = defaultChat,
  onEvent = () => {},
  maxSteps = MAX_STEPS,
  ctx = {}
} = {}) {
  let step = 0;
  let lastCallSignature = null;
  let consecutiveIdenticalCount = 0;
  let externalContentRead = false;
  ctx.registry = registry;
  const permissionManager = ctx.permissionManager || PermissionManager.fromConfigFile(ctx.cwd);
  const snapshotManager = ctx.snapshotManager || new SessionSnapshotManager(ctx.cwd);

  // Run message hooks once per agent turn, before the model sees the latest user message.
  const latestUserMessage = [...messages].reverse().find(message => message?.role === 'user');
  if (latestUserMessage && ctx.pluginManager) {
    await ctx.pluginManager.runHook('on_message', {
      message: latestUserMessage,
      messages,
      ctx,
      workingDir: ctx.cwd || process.cwd()
    });
  }

  while (step < maxSteps) {
    if (ctx.abortSignal?.aborted) {
      const abortError = new Error('Session execution aborted by user.');
      onEvent({ type: 'error', error: abortError, step });
      return {
        completed: false,
        reason: 'aborted',
        steps: step,
        messages,
        finalMessage: messages[messages.length - 1]
      };
    }

    step++;

    const toolDefinitions = registry.getDefinitions();

    const llmOptions = {
      ...(ctx.llmOptions || {}),
      signal: ctx.abortSignal,
      onToken: (tok) => onEvent({ type: 'text.delta', text: tok, step })
    };

    // Redact secrets from a copy of messages before sending to model
    const redactedMessages = messages.map(m => {
      if (m && typeof m.content === 'string') {
        return { ...m, content: redactSecrets(m.content) };
      }
      return m;
    });

    let assistantMessage;
    try {
      assistantMessage = await chatFn(redactedMessages, toolDefinitions, llmOptions);
    } catch (err) {
      onEvent({ type: 'error', error: err, step });
      throw err;
    }

    if (assistantMessage.usage && ctx.session?.addUsage) {
      ctx.session.addUsage(assistantMessage.usage);
    }

    messages.push(assistantMessage);

      // ✅ TAHAP 8: Context Management - Check if compaction needed after assistant message
      const model = ctx.model || ctx.session?.model || '';
      const compactionResult = await compactContextIfNeeded(messages, model, onEvent);

      if (compactionResult.compacted) {
        onEvent({
          type: 'context.compacted',
          step,
          oldMessageCount: messages.length,
          newMessageCount: compactionResult.newMessages.length,
          summary: compactionResult.summary,
          usageRatioBefore: compactionResult.usage.usageRatio,
          usageRatioAfter: compactionResult.newUsageRatio
        });
      }

      messages = compactionResult.messages;

    if (ctx.sessionManager && ctx.session) {
      ctx.session.messages = messages;
      ctx.sessionManager.saveSessionSync?.(ctx.session);
    }

    const toolCalls = assistantMessage.tool_calls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
      const doneResult = {
        completed: true,
        reason: 'stop',
        steps: step,
        messages,
        finalMessage: assistantMessage,
        usage: ctx.session?.usage || assistantMessage.usage
      };
      onEvent({ type: 'done', ...doneResult });
      return doneResult;
    }

    for (const toolCall of toolCalls) {
      if (ctx.abortSignal?.aborted) {
        const abortResult = {
          completed: false,
          reason: 'aborted',
          steps: step,
          messages,
          finalMessage: messages[messages.length - 1]
        };
        onEvent({ type: 'done', ...abortResult });
        return abortResult;
      }

      const callId = toolCall.id;
      const toolName = toolCall.function?.name;
      const rawArgs = toolCall.function?.arguments;

      // 1. Safe JSON argument parsing
      let parsedArgs = rawArgs;
      if (typeof rawArgs === 'string') {
        try {
          parsedArgs = JSON.parse(rawArgs);
        } catch (err) {
          const parseErrorOutput = `Error: Invalid JSON arguments for tool "${toolName}": ${err.message}. Received: ${rawArgs}`;
          messages.push({
            role: 'tool',
            tool_call_id: callId,
            name: toolName,
            content: parseErrorOutput
          });
          onEvent({
            type: 'tool.result',
            id: callId,
            name: toolName,
            output: parseErrorOutput,
            step
          });
          continue;
        }
      }

      onEvent({
        type: 'tool.start',
        id: callId,
        name: toolName,
        args: parsedArgs,
        rawArgs,
        step
      });

      // 2. Loop Detection: Check if identical tool + args called 3 times consecutively
      const currentSignature = `${toolName}:${canonicalize(parsedArgs)}`;
      if (currentSignature === lastCallSignature) {
        consecutiveIdenticalCount++;
      } else {
        lastCallSignature = currentSignature;
        consecutiveIdenticalCount = 1;
      }

      if (consecutiveIdenticalCount >= 3) {
        const loopWarning = `Warning: Loop detected. You have called tool "${toolName}" with identical arguments 3 times consecutively. This execution was blocked to prevent an infinite loop. Stop repeating this call, analyze the previous output, and use a different approach or report your findings.`;
        messages.push({
          role: 'tool',
          tool_call_id: callId,
          name: toolName,
          content: loopWarning
        });
        onEvent({
          type: 'loop.detected',
          id: callId,
          name: toolName,
          step,
          consecutiveCount: consecutiveIdenticalCount
        });
        onEvent({
          type: 'tool.result',
          id: callId,
          name: toolName,
          output: loopWarning,
          step
        });
        continue;
      }

      // Plugins may inspect or adjust arguments, but permission checks still run afterwards.
      const beforeTool = {
        name: toolName,
        tool: registry.get(toolName),
        args: parsedArgs || {},
        ctx,
        cancelled: false,
        reason: ''
      };
      if (ctx.pluginManager) await ctx.pluginManager.runHook('before_tool', beforeTool);
      parsedArgs = beforeTool.args || {};

      // 3. Capture snapshot before first modification in session
      if (toolName === 'write_file' || toolName === 'edit_file') {
        try {
          await snapshotManager.captureFirstSnapshot();
        } catch (err) {
          console.warn(`[Snapshot warning]: ${err.message}`);
        }
      }

      // 3. Evaluate permission
      let toolOutput;
      const auth = beforeTool.cancelled
        ? { allowed: false, error: beforeTool.reason || `Tool "${toolName}" was cancelled by a plugin hook.` }
        : await permissionManager.authorize(toolName, parsedArgs || {}, {
        ...ctx,
        externalContentRead,
        askUser: async ({ tool, args, reason }) => {
          if (ctx.autoApprove) return true;
          const reqId = `perm_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
          onEvent({
            type: 'permission.request',
            id: reqId,
            tool,
            args,
            reason,
            step
          });
          if (typeof ctx.resolvePermission === 'function') {
            return await ctx.resolvePermission(reqId, { tool, args, reason });
          }
          if (typeof ctx.askUser === 'function') {
            return await ctx.askUser({ id: reqId, tool, args, reason });
          }
          return false;
        }
      });

      if (!auth.allowed) {
        toolOutput = auth.error || `Permission denied for tool ${toolName}`;
      } else {
        try {
          toolOutput = await registry.execute(toolName, parsedArgs, ctx);
        } catch (err) {
          toolOutput = `Error: Tool execution failed unexpectedly: ${err.message}`;
        }
      }

      // Plugins can inspect or transform the completed result.
      const afterTool = {
        name: toolName,
        tool: registry.get(toolName),
        args: parsedArgs || {},
        ctx,
        allowed: auth.allowed,
        output: String(toolOutput ?? '')
      };
      if (ctx.pluginManager) await ctx.pluginManager.runHook('after_tool', afterTool);
      toolOutput = afterTool.output;

      // Redact secrets in tool output before sending to model
      toolOutput = redactSecrets(String(toolOutput ?? ''));

      // Prompt-injection mitigation: wrap untrusted external content
      const inj = await import('./injection.js');
      if (inj.isUntrustedTool(toolName) && !String(toolOutput).startsWith('Error')) {
        toolOutput = inj.wrapUntrusted(toolOutput, toolName);
        externalContentRead = true;
      }

      // Audit log
      appendAuditEntry(ctx.cwd || process.cwd(), {
        tool: toolName,
        args: parsedArgs,
        result: toolOutput,
        allowed: auth.allowed,
        step,
        externalContentRead
      });

      const toolMessage = {
        role: 'tool',
        tool_call_id: callId,
        name: toolName,
        content: toolOutput
      };

      messages.push(toolMessage);

      // ✅ TAHAP 8: Context Management - Check if compaction needed after tool result
      const model = ctx.model || ctx.session?.model || '';
      const compactionResult = await compactContextIfNeeded(messages, model, onEvent);

      if (compactionResult.compacted) {
        onEvent({
          type: 'context.compacted',
          step,
          oldMessageCount: messages.length,
          newMessageCount: compactionResult.newMessages.length,
          summary: compactionResult.summary,
          usageRatioBefore: compactionResult.usage.usageRatio,
          usageRatioAfter: compactionResult.newUsageRatio
        });
      }

      messages = compactionResult.messages;

      onEvent({
        type: 'tool.result',
        id: callId,
        name: toolName,
        output: toolOutput,
        step
      });
    }
  }

  const maxStepsResult = {
    completed: false,
    reason: 'max_steps_reached',
    steps: step,
    messages,
    finalMessage: messages[messages.length - 1],
    usage: ctx.session?.usage
  };

  onEvent({ type: 'done', ...maxStepsResult });
  return maxStepsResult;
}
