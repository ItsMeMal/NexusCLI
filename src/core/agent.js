import fs from 'node:fs';
import path from 'node:path';

/**
 * Parse markdown agent definition with YAML-like frontmatter.
 * Format:
 * ---
 * description: ...
 * model: ...
 * tools: read_file, grep, glob
 * permission: read-only
 * ---
 * System prompt body here.
 */
export function parseAgentMarkdown(content) {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: (content || '').trim() };
  }
  const frontmatter = {};
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (key === 'tools') {
      frontmatter.tools = val.split(',').map(s => s.trim()).filter(Boolean);
    } else if (key === 'permission') {
      frontmatter.permission = val;
    } else {
      frontmatter[key] = val;
    }
  }
  return { frontmatter, body: (match[2] || '').trim() };
}

export function getAgentsDir(workingDir = process.cwd()) {
  return path.join(workingDir, '.agent', 'agents');
}

export function loadAgents(workingDir = process.cwd()) {
  const agents = new Map();
  const dir = getAgentsDir(workingDir);
  if (!fs.existsSync(dir)) return agents;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return agents;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const name = entry.name.replace(/\.md$/, '');
    try {
      const content = fs.readFileSync(path.join(dir, entry.name), 'utf8');
      const { frontmatter, body } = parseAgentMarkdown(content);
      agents.set(name, {
        name,
        description: frontmatter.description || '',
        model: frontmatter.model || '',
        tools: Array.isArray(frontmatter.tools) ? frontmatter.tools : [],
        permission: frontmatter.permission || 'default',
        systemPrompt: body
      });
    } catch {
      // skip unreadable
    }
  }
  return agents;
}

export function getAgent(workingDir, name) {
  const agents = loadAgents(workingDir);
  return agents.get(name) || null;
}

export function listAgentNames(workingDir = process.cwd()) {
  return Array.from(loadAgents(workingDir).keys());
}

export default { parseAgentMarkdown, loadAgents, getAgent, listAgentNames, getAgentsDir };