import fs from 'node:fs';
import path from 'node:path';

const SKILL_ROOTS = ['.agent/skills', '.claude/skills'];
const MAX_SKILLS = 20;
const MAX_SKILL_CHARS = 12_000;
const MAX_TOTAL_CHARS = 60_000;

function validSkillName(name) {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(String(name || ''));
}

/**
 * Load project-scoped skills from NexusCode and Claude-compatible locations.
 * Supported layouts:
 *   .agent/skills/<name>/SKILL.md
 *   .agent/skills/<name>.md
 *   .claude/skills/<name>/SKILL.md
 *   .claude/skills/<name>.md
 *
 * Symlinks are ignored so skill discovery cannot escape the workspace.
 */
export function loadWorkspaceSkills(workingDir = process.cwd()) {
  const workspace = path.resolve(workingDir);
  const discovered = new Map();

  for (const relativeRoot of SKILL_ROOTS) {
    const root = path.resolve(workspace, relativeRoot);
    if (!root.startsWith(workspace + path.sep) || !fs.existsSync(root)) continue;

    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (discovered.size >= MAX_SKILLS) break;
      let name = '';
      let filePath = '';

      if (entry.isDirectory()) {
        name = entry.name;
        filePath = path.join(root, entry.name, 'SKILL.md');
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        name = entry.name.replace(/\.md$/i, '');
        filePath = path.join(root, entry.name);
      } else {
        continue;
      }

      if (!validSkillName(name) || discovered.has(name) || !fs.existsSync(filePath)) continue;

      try {
        const stat = fs.lstatSync(filePath);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        const realPath = fs.realpathSync(filePath);
        if (!realPath.startsWith(root + path.sep)) continue;

        const content = fs.readFileSync(realPath, 'utf8').trim();
        if (!content) continue;
        discovered.set(name, {
          name,
          source: relativeRoot,
          content: content.slice(0, MAX_SKILL_CHARS)
        });
      } catch {
        // Ignore unreadable or malformed skill files.
      }
    }
    if (discovered.size >= MAX_SKILLS) break;
  }

  const skills = [];
  let totalChars = 0;
  for (const skill of discovered.values()) {
    const remaining = MAX_TOTAL_CHARS - totalChars;
    if (remaining <= 0) break;
    const content = skill.content.slice(0, remaining);
    skills.push({ ...skill, content });
    totalChars += content.length;
  }
  return skills;
}

export default loadWorkspaceSkills;
