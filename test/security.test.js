import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileTool } from '../src/tools/read.js';
import { writeFileTool } from '../src/tools/write.js';
import { editFileTool } from '../src/tools/edit.js';
import { bashTool } from '../src/tools/bash.js';
import { PermissionManager, assertPathWithinCwd } from '../src/core/permission.js';
import { SessionSnapshotManager } from '../src/core/snapshot.js';
import { runAgentLoop } from '../src/core/loop.js';
import { ToolRegistry } from '../src/tools/index.js';

const execAsync = promisify(exec);

describe('Security: Path Traversal Rejection', () => {
  const cwd = path.resolve('test_sandbox');

  before(async () => {
    await fs.mkdir(cwd, { recursive: true });
  });

  after(async () => {
    await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
  });

  test('assertPathWithinCwd blocks parent navigation (../)', () => {
    assert.throws(
      () => assertPathWithinCwd('../secret.txt', cwd),
      /Access denied: Path "\.\.\/secret\.txt" resolves outside working directory/
    );
  });

  test('assertPathWithinCwd blocks absolute path outside cwd', () => {
    const outside = path.resolve(cwd, '..', 'external.txt');
    assert.throws(
      () => assertPathWithinCwd(outside, cwd),
      /resolves outside working directory/
    );
  });

  test('read_file returns access denied error on path traversal', async () => {
    const res = await readFileTool.execute({ path: '../../etc/passwd' }, { cwd });
    assert.match(res, /Access denied/);
  });

  test('write_file returns access denied error on path traversal', async () => {
    const res = await writeFileTool.execute({ path: '../evil.js', content: 'hack' }, { cwd });
    assert.match(res, /Access denied/);
  });

  test('edit_file returns access denied error on path traversal', async () => {
    const res = await editFileTool.execute({
      path: '../target.js',
      old_str: 'a',
      new_str: 'b'
    }, { cwd });
    assert.match(res, /Access denied/);
  });
});

describe('Security: Permission Policies & Command Deny', () => {
  test('PermissionManager evaluates default policies', () => {
    const pm = new PermissionManager();

    // Default allow tools
    assert.equal(pm.evaluate('read_file').action, 'allow');
    assert.equal(pm.evaluate('grep').action, 'allow');
    assert.equal(pm.evaluate('glob').action, 'allow');

    // Default ask tools
    assert.equal(pm.evaluate('write_file').action, 'ask');
    assert.equal(pm.evaluate('edit_file').action, 'ask');

    // Bash rules
    assert.equal(pm.evaluate('bash', { command: 'git status' }).action, 'allow');
    assert.equal(pm.evaluate('bash', { command: 'npm test' }).action, 'allow');
    assert.equal(pm.evaluate('bash', { command: 'node --test' }).action, 'allow');
    assert.equal(pm.evaluate('bash', { command: 'rm -rf node_modules' }).action, 'ask');
    assert.equal(pm.evaluate('bash', { command: 'sudo rm -rf /' }).action, 'deny');
  });

  test('denied command is never executed in agent loop', async () => {
    let commandActuallyRan = false;

    const registry = new ToolRegistry();
    registry.register({
      name: 'bash',
      description: 'bash',
      async execute({ command }) {
        commandActuallyRan = true;
        return 'executed';
      }
    });

    const messages = [{ role: 'user', content: 'run privileged command' }];

    const mockChat = async () => ({
      role: 'assistant',
      tool_calls: [
        {
          id: 'call_deny',
          type: 'function',
          function: {
            name: 'bash',
            arguments: JSON.stringify({ command: 'sudo reboot' })
          }
        }
      ]
    });

    const result = await runAgentLoop({
      messages,
      registry,
      chatFn: mockChat,
      maxSteps: 1,
      ctx: {
        permissionManager: new PermissionManager()
      }
    });

    assert.equal(commandActuallyRan, false, 'Denied command must NEVER be executed');
    const toolMsg = messages.find(m => m.role === 'tool');
    assert.ok(toolMsg);
    assert.match(toolMsg.content, /Permission denied: Action explicitly blocked by policy/);
  });
});

describe('Security: Snapshot & /undo Restoration', () => {
  const repoDir = path.resolve('test_git_sandbox');

  before(async () => {
    await fs.rm(repoDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(repoDir, { recursive: true });

    // Initialize clean git repository
    await execAsync('git init', { cwd: repoDir });
    await execAsync('git config user.email "test@nexus.local"', { cwd: repoDir });
    await execAsync('git config user.name "Nexus Test"', { cwd: repoDir });

    await fs.writeFile(path.join(repoDir, 'app.js'), 'const version = "1.0.0";\n', 'utf8');
    await execAsync('git add .', { cwd: repoDir });
    await execAsync('git commit -m "initial commit"', { cwd: repoDir });
  });

  after(async () => {
    await fs.rm(repoDir, { recursive: true, force: true }).catch(() => {});
  });

  test('/undo reverts file edits and removes newly created untracked files', async () => {
    const snapshotManager = new SessionSnapshotManager(repoDir);

    // 1. Take initial snapshot before modifications
    await snapshotManager.captureFirstSnapshot();
    assert.ok(snapshotManager.initialRef);

    // 2. Perform file modification and create untracked file
    await fs.writeFile(path.join(repoDir, 'app.js'), 'const version = "2.0.0";\n', 'utf8');
    await fs.writeFile(path.join(repoDir, 'unwanted.tmp'), 'garbage data', 'utf8');

    const modifiedContent = await fs.readFile(path.join(repoDir, 'app.js'), 'utf8');
    assert.match(modifiedContent, /2\.0\.0/);

    // 3. Trigger /undo restore
    const restoreResult = await snapshotManager.restore();
    assert.equal(restoreResult.success, true);

    // 4. Verify file reverted to original version
    const revertedContent = await fs.readFile(path.join(repoDir, 'app.js'), 'utf8');
    assert.match(revertedContent, /1\.0\.0/);

    // 5. Verify untracked file was deleted
    let junkExists = true;
    try {
      await fs.access(path.join(repoDir, 'unwanted.tmp'));
    } catch {
      junkExists = false;
    }
    assert.equal(junkExists, false, 'Untracked files created after snapshot must be deleted');
  });
});

describe('Security: Bash Timeout & Process Kill', () => {
  test('terminates and kills process when timeout expires', async () => {
    const startTime = Date.now();
    const res = await bashTool.execute(
      { command: 'node -e "setTimeout(() => {}, 10000)"' },
      { timeout: 500 }
    );
    const elapsed = Date.now() - startTime;

    assert.match(res, /timed out after 500ms and was killed/);
    assert.ok(elapsed < 4000, `Command should terminate quickly around timeout (elapsed: ${elapsed}ms)`);
  });
});
