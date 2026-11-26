import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ToolRegistry, createDefaultRegistry } from '../src/tools/index.js';
import { readFileTool } from '../src/tools/read.js';
import { writeFileTool } from '../src/tools/write.js';
import { editFileTool } from '../src/tools/edit.js';
import { bashTool } from '../src/tools/bash.js';
import { grepTool } from '../src/tools/grep.js';
import { globTool } from '../src/tools/glob.js';
import { buildSystemPrompt } from '../src/core/prompt.js';

describe('ToolRegistry', () => {
  test('register and retrieve tools', () => {
    const registry = new ToolRegistry();
    registry.register(readFileTool);

    assert.equal(registry.has('read_file'), true);
    assert.equal(registry.has('non_existent'), false);
    assert.equal(registry.get('read_file'), readFileTool);
    assert.equal(registry.list().length, 1);
  });

  test('generates valid OpenAI tool definitions', () => {
    const registry = createDefaultRegistry();
    const defs = registry.getDefinitions();

    assert.equal(defs.length, 10);
    for (const def of defs) {
      assert.equal(def.type, 'function');
      assert.ok(def.function.name);
      assert.ok(def.function.description);
      assert.equal(typeof def.function.parameters, 'object');
    }
  });

  test('executes tool with object arguments and parses string JSON', async () => {
    const registry = createDefaultRegistry();
    const tempFile = path.resolve('test_temp_reg.txt');

    try {
      // String JSON argument
      const writeResult = await registry.execute('write_file', JSON.stringify({
        path: tempFile,
        content: 'hello registry'
      }));
      assert.match(writeResult, /File successfully written/);

      // Object argument
      const readResult = await registry.execute('read_file', {
        path: tempFile
      });
      assert.equal(readResult, 'hello registry');
    } finally {
      await fs.unlink(tempFile).catch(() => {});
    }
  });

  test('returns error on unknown tool', async () => {
    const registry = createDefaultRegistry();
    const res = await registry.execute('invalid_tool', {});
    assert.match(res, /Error: Unknown tool "invalid_tool"/);
  });

  test('truncates oversized output at 8000 chars with [dipotong]', () => {
    const registry = new ToolRegistry();
    const longString = 'a'.repeat(9000);
    const truncated = registry.truncateOutput(longString);

    assert.ok(truncated.length < 9000);
    assert.match(truncated, /\[dipotong: sisa 1000 karakter diabaikan/);
  });
});

describe('Individual Tools', () => {
  test('read_file handles missing file cleanly', async () => {
    const res = await readFileTool.execute({ path: 'does_not_exist_file_xyz.txt' });
    assert.match(res, /Error reading file/);
  });

  test('write_file requires path and content', async () => {
    const res1 = await writeFileTool.execute({});
    assert.match(res1, /Error: "path" argument is required/);

    const res2 = await writeFileTool.execute({ path: 'a.txt' });
    assert.match(res2, /Error: "content" argument is required/);
  });

  test('edit_file successfully replaces exact single occurrence', async () => {
    const tempFile = path.resolve('test_temp_edit.txt');
    try {
      await fs.writeFile(tempFile, 'line 1\nconst x = 10;\nline 3\n');
      const res = await editFileTool.execute({
        path: tempFile,
        old_str: 'const x = 10;',
        new_str: 'const x = 20;'
      });
      assert.match(res, /successfully edited/);

      const updated = await fs.readFile(tempFile, 'utf8');
      assert.equal(updated, 'line 1\nconst x = 20;\nline 3\n');
    } finally {
      await fs.unlink(tempFile).catch(() => {});
    }
  });

  test('edit_file fails with helpful snippet if old_str not found', async () => {
    const tempFile = path.resolve('test_temp_edit_miss.txt');
    try {
      await fs.writeFile(tempFile, 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
      const res = await editFileTool.execute({
        path: tempFile,
        old_str: 'const b = 999;',
        new_str: 'const b = 200;'
      });
      assert.match(res, /Error: old_str not found/);
      assert.match(res, /Relevant file snippet/);
      assert.match(res, /const b = 2;/);
    } finally {
      await fs.unlink(tempFile).catch(() => {});
    }
  });

  test('edit_file fails if old_str occurs multiple times', async () => {
    const tempFile = path.resolve('test_temp_edit_multi.txt');
    try {
      await fs.writeFile(tempFile, 'foo\nbar\nfoo\n');
      const res = await editFileTool.execute({
        path: tempFile,
        old_str: 'foo',
        new_str: 'baz'
      });
      assert.match(res, /Error: old_str found 2 times/);
      assert.match(res, /old_str must be unique/);
    } finally {
      await fs.unlink(tempFile).catch(() => {});
    }
  });

  test('glob tool finds matching files', async () => {
    const res = await globTool.execute({ pattern: 'src/**/*.js' });
    assert.match(res, /src\/cli\.js/);
    assert.match(res, /src\/core\/prompt\.js/);
  });

  test('bash tool executes command and captures output', async () => {
    const res = await bashTool.execute({ command: 'node -e "console.log(12345)"' });
    assert.equal(res.trim(), '12345');
  });

  test('bash tool handles failed command without crash', async () => {
    const res = await bashTool.execute({ command: 'node -e "process.exit(1)"' });
    assert.match(res, /Command failed/);
  });

  test('bash tool terminates a running command when interrupted', async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const abortTimer = setTimeout(() => controller.abort(), 150);

    try {
      const result = await bashTool.execute({
        command: 'node -e "setTimeout(() => console.log(\'late\'), 5000)"'
      }, {
        abortSignal: controller.signal,
        timeout: 10000
      });

      assert.match(result, /Command cancelled by user/i);
      assert.ok(Date.now() - startedAt < 4000, 'command should stop promptly after abort');
    } finally {
      clearTimeout(abortTimer);
    }
  });

  test('grep tool finds matching lines', async () => {
    const res = await grepTool.execute({ pattern: 'NEXUSCODE', path: 'src/cli.js' });
    assert.match(res, /src\/cli\.js:\d+:/);
  });
});

describe('Prompt Generator', () => {
  test('buildSystemPrompt includes core directives and AGENTS.md', () => {
    const prompt = buildSystemPrompt({ workingDir: process.cwd() });
    assert.match(prompt, /READ BEFORE EDIT/);
    assert.match(prompt, /PREFER EDIT OVER REWRITE/);
    assert.match(prompt, /VERIFY VIA TESTS/);
    assert.match(prompt, /Project Specific Guidelines \(from AGENTS\.md\)/);
  });
});
