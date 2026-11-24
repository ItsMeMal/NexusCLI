async function getRunAgentLoop() {
  const mod = await import('../core/loop.js');
  return mod.runAgentLoop;
}
import { ToolRegistry } from './registry.js';
import { getAgent, listAgentNames } from '../core/agent.js';
import { readFileTool } from './read.js';
import { writeFileTool } from './write.js';
import { editFileTool } from './edit.js';
import { bashTool } from './bash.js';
import { grepTool } from './grep.js';
import { globTool } from './glob.js';
import { todoTool } from './todo.js';
import { webfetchTool } from './webfetch.js';
import { repoMapTool } from './repo_map.js';
import path from 'node:path';

const ALL_TOOL_NAMES = [
  'read_file', 'write_file', 'edit_file', 'bash', 'grep',
  'glob', 'todo', 'webfetch', 'repo_map'
];

const READ_ONLY_TOOLS = new Set([
  'read_file', 'grep', 'glob', 'repo_map', 'webfetch'
]);

const TOOL_MAP = {
  read_file: readFileTool,
  write_file: writeFileTool,
  edit_file: editFileTool,
  bash: bashTool,
  grep: grepTool,
  glob: globTool,
  todo: todoTool,
  webfetch: webfetchTool,
  repo_map: repoMapTool
};

function buildRegistryForAgent(agent, baseRegistry) {
  const reg = new ToolRegistry();
  const allowed = (agent.tools && agent.tools.length > 0)
    ? agent.tools
    : ALL_TOOL_NAMES;
  for (const name of allowed) {
    if (name === 'task') continue;
    const t = (baseRegistry && baseRegistry.get(name)) || TOOL_MAP[name];
    if (t) reg.register(t);
  }
  if (agent.permission === 'read-only') {
    for (const name of Array.from(reg.tools.keys())) {
      if (!READ_ONLY_TOOLS.has(name)) {
        reg.tools.delete(name);
      }
    }
  }
  return reg;
}

async function runOneSubagent({ agent: agentName, prompt }, ctx) {
  const workingDir = ctx.cwd || process.cwd();
  const agent = getAgent(workingDir, agentName);
  if (!agent) {
    const available = (await import('../core/agent.js')).listAgentNames(workingDir);
    return `Error: Unknown agent "${agentName}". Available agents: ${available.join(', ') || '(none)'}.`;
  }

  const registry = buildRegistryForAgent(agent, ctx.registry);

  const messages = [];
  if (agent.systemPrompt) {
    messages.push({ role: 'system', content: agent.systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });

  const subCtx = {
    ...ctx,
    depth: (ctx.depth || 0) + 1,
    registry,
    // subagents inherit model override if agent specifies one
    model: agent.model || ctx.model
  };

  const runAgentLoop = await getRunAgentLoop();
  let result;
  try {
    result = await runAgentLoop({
      messages,
      registry,
      chatFn: ctx.chatFn,
      maxSteps: 15,
      ctx: subCtx
    });
  } catch (err) {
    return `Subagent "${agentName}" failed: ${err.message}`;
  }

  const final = result?.finalMessage?.content;
  const summary = (typeof final === 'string' && final.trim())
    ? final.trim()
    : '(subagent produced no textual summary)';

  const truncated = summary.length > 4000
    ? summary.slice(0, 4000) + '\n...[truncated]'
    : summary;

  return `--- Subagent "${agentName}" summary ---\n${truncated}`;
}

export const taskTool = {
  name: 'task',
  description:
    'Spawn one or more subagents in isolated context. Each subagent runs its own agent loop and returns a concise summary. Supports parallel execution when given a "tasks" array. Subagents cannot spawn further subagents.',
  parameters: {
    type: 'object',
    properties: {
      agent: {
        type: 'string',
        description: 'Agent name defined in .agent/agents/*.md (single mode)'
      },
      prompt: {
        type: 'string',
        description: 'Task prompt for the subagent (single mode)'
      },
      tasks: {
        type: 'array',
        description: 'Parallel mode: array of {agent, prompt} objects',
        items: {
          type: 'object',
          properties: {
            agent: { type: 'string' },
            prompt: { type: 'string' }
          },
          required: ['agent', 'prompt']
        }
      }
    }
  },
  async execute(args, ctx = {}) {
    // Depth guard: subagents must not spawn subagents.
    if ((ctx.depth || 0) >= 1) {
      return 'Error: Subagents cannot spawn further subagents (depth limit reached).';
    }

    const parallel = Array.isArray(args?.tasks) && args.tasks.length > 0;
    if (parallel) {
      const items = args.tasks
        .filter(t => t && t.agent && t.prompt)
        .map(t => ({ agent: String(t.agent), prompt: String(t.prompt) }));
      if (items.length === 0) {
        return 'Error: "tasks" array must contain objects with "agent" and "prompt".';
      }
      const results = await Promise.all(items.map(item => runOneSubagent(item, ctx)));
      return results.join('\n\n');
    }

    if (args?.agent && args?.prompt) {
      return await runOneSubagent(
        { agent: String(args.agent), prompt: String(args.prompt) },
        ctx
      );
    }

    return 'Error: Provide either {agent, prompt} or {tasks: [{agent, prompt}, ...]}.';
  }
};

export default taskTool;