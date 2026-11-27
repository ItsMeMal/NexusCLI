import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandManager } from '../src/core/command.js';
import { loadWorkspaceSkills } from '../src/core/skills.js';
import { buildSystemPrompt } from '../src/core/prompt.js';
import { createNexusServer } from '../src/server.js';

async function makeWorkspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nexuscode-custom-workspace-'));
}

test('custom slash commands resolve arguments and substitute $ARGUMENTS', async (t) => {
  const workspace = await makeWorkspace();
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));

  const commandsDir = path.join(workspace, '.agent', 'commands');
  await fs.mkdir(commandsDir, { recursive: true });
  await fs.writeFile(path.join(commandsDir, 'review.md'),
    'Review this target: $ARGUMENTS\nCheck correctness and security.', 'utf8');

  const manager = new CommandManager(workspace);
  assert.deepEqual(manager.loadCommands(), ['review']);

  const resolved = manager.resolveInput('/review src/server.js --security');
  assert.equal(resolved.name, 'review');
  assert.equal(resolved.arguments, 'src/server.js --security');
  assert.match(resolved.content, /User invoked the custom workspace command "\/review"/);
  assert.match(resolved.content, /Review this target: src\/server\.js --security/);
  assert.equal(manager.resolveInput('/unknown anything'), null);
  assert.equal(manager.resolveInput('ordinary user message'), null);
});

test('workspace skills load from NexusCode and Claude-compatible skill directories', async (t) => {
  const workspace = await makeWorkspace();
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));

  const nexusSkill = path.join(workspace, '.agent', 'skills', 'api-review', 'SKILL.md');
  const claudeSkill = path.join(workspace, '.claude', 'skills', 'testing', 'SKILL.md');
  const directSkill = path.join(workspace, '.agent', 'skills', 'documentation.md');
  await fs.mkdir(path.dirname(nexusSkill), { recursive: true });
  await fs.mkdir(path.dirname(claudeSkill), { recursive: true });
  await fs.mkdir(path.dirname(directSkill), { recursive: true });
  await fs.writeFile(nexusSkill, '# API Review\nCheck auth boundaries.', 'utf8');
  await fs.writeFile(claudeSkill, '# Testing\nPrefer deterministic tests.', 'utf8');
  await fs.writeFile(directSkill, '# Documentation\nKeep docs accurate.', 'utf8');

  const skills = loadWorkspaceSkills(workspace);
  assert.deepEqual(skills.map(skill => skill.name), ['api-review', 'documentation', 'testing']);
  assert.equal(skills.find(skill => skill.name === 'testing').source, '.claude/skills');

  const prompt = buildSystemPrompt({ workingDir: workspace, mode: 'build' });
  assert.match(prompt, /WORKSPACE SKILLS/);
  assert.match(prompt, /Check auth boundaries/);
  assert.match(prompt, /Prefer deterministic tests/);
  assert.match(prompt, /Keep docs accurate/);
});

test('server publishes and executes custom workspace slash commands', async (t) => {
  const workspace = await makeWorkspace();
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));

  const commandsDir = path.join(workspace, '.agent', 'commands');
  await fs.mkdir(commandsDir, { recursive: true });
  await fs.writeFile(path.join(commandsDir, 'review.md'),
    'Review the requested target for security issues: $ARGUMENTS', 'utf8');

  let resolveObserved;
  const observedMessage = new Promise(resolve => { resolveObserved = resolve; });
  const nexus = createNexusServer({
    workingDir: workspace,
    host: '127.0.0.1',
    port: 0,
    chatFn: async messages => {
      const latestUser = [...messages].reverse().find(message => message.role === 'user');
      resolveObserved(latestUser?.content || '');
      return { role: 'assistant', content: 'Custom command completed.' };
    }
  });

  const info = await nexus.start();
  t.after(() => nexus.close());

  const commandResponse = await fetch(info.url + '/commands');
  assert.equal(commandResponse.status, 200);
  assert.deepEqual((await commandResponse.json()).commands, ['review']);

  const sessionResponse = await fetch(info.url + '/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'build', model: 'test-model' })
  });
  assert.equal(sessionResponse.status, 201);
  const session = await sessionResponse.json();

  const messageResponse = await fetch(info.url + `/session/${session.id}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '/review src/auth.js' })
  });
  assert.equal(messageResponse.status, 202);

  const observed = await Promise.race([
    observedMessage,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Agent did not receive custom command')), 5000))
  ]);
  assert.match(observed, /User invoked the custom workspace command "\/review"/);
  assert.match(observed, /Review the requested target for security issues: src\/auth\.js/);
});
