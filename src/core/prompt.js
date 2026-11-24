import fs from 'node:fs';
import path from 'node:path';

export function loadAgentsMarkdown(workingDir = process.cwd()) {
  const candidates = ['AGENTS.md', 'agents.md'];
  for (const candidate of candidates) {
    const filePath = path.resolve(workingDir, candidate);
    if (fs.existsSync(filePath)) {
      try {
        return fs.readFileSync(filePath, 'utf8');
      } catch {
        // Return null if cannot read
      }
    }
  }
  return null;
}

export function buildSystemPrompt(options = {}) {
  const workingDir = options.workingDir || process.cwd();
  const mode = options.mode || 'build';

  const modeDirective = mode === 'plan'
    ? `## CURRENT MODE: PLAN (Read-Only)
You are operating in PLAN mode.
You may read, search, and inspect code using read_file, grep, and glob.
You MUST NOT edit, write, or modify files. Formulate a clear, structured implementation plan.`
    : `## CURRENT MODE: BUILD (Full Execution)
You are operating in BUILD mode.
You are authorized to read, write, and edit files, and execute verification commands.`;

  const corePrompt = `You are Nexus, an expert autonomous coding agent CLI.
You execute engineering tasks by invoking available tools (read_file, write_file, edit_file, bash, grep, glob, task) in an agent loop.

${modeDirective}

## Core Operational Directives:
1. READ BEFORE EDIT: Always inspect file contents using \`read_file\` or locate code with \`grep\` / \`glob\` before modifying code.
2. PREFER EDIT OVER REWRITE: Use \`edit_file\` for targeted, atomic modifications. Never rewrite whole files with \`write_file\` when making small fixes or refactors.
3. VERIFY VIA TESTS: Always run automated tests, scripts, or syntax checks via \`bash\` after modifying code. Never claim something works without running proof.
4. NO UNNECESSARY FILES: Do not create redundant, temporary, or unrequested files.
5. CONCISE & FACTUAL: Keep responses direct, technically accurate, and focused on verified outcomes.`;

  const agentsMdContent = loadAgentsMarkdown(workingDir);
  if (agentsMdContent && agentsMdContent.trim()) {
    return `${corePrompt}\n\n## Project Specific Guidelines (from AGENTS.md):\n${agentsMdContent.trim()}`;
  }

  return corePrompt;
}
