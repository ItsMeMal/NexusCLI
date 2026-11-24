import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { processSSEChunks } from '../src/core/llm.js';
import { Session, SessionManager } from '../src/core/session.js';
import { PermissionManager } from '../src/core/permission.js';
import { runAgentLoop } from '../src/core/loop.js';
import { ToolRegistry } from '../src/tools/index.js';

describe('UX: Streaming & Delta Parsing', () => {
  test('processSSEChunks streams tokens and merges chunked tool_calls', async () => {
    const sseLines = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_read_1","function":{"name":"read_file"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\": "}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"test.txt\\"}"}}]}}]}\n\n',
      'data: {"usage":{"prompt_tokens":12,"completion_tokens":18,"total_tokens":30}}\n\n',
      'data: [DONE]\n\n'
    ];

    const tokensReceived = [];
    const encoder = new TextEncoder();

    // Mock Web Stream reader
    let lineIdx = 0;
    const mockReader = {
      async read() {
        if (lineIdx >= sseLines.length) {
          return { done: true, value: undefined };
        }
        const val = encoder.encode(sseLines[lineIdx++]);
        return { done: false, value: val };
      }
    };

    const result = await processSSEChunks(mockReader, {
      onToken: (tok) => tokensReceived.push(tok)
    });

    // Verify token streaming
    assert.deepEqual(tokensReceived, ['Hello', ' world']);
    assert.equal(result.content, 'Hello world');

    // Verify delta tool_calls assembly
    assert.ok(result.tool_calls);
    assert.equal(result.tool_calls.length, 1);
    assert.equal(result.tool_calls[0].id, 'call_read_1');
    assert.equal(result.tool_calls[0].function.name, 'read_file');
    assert.equal(result.tool_calls[0].function.arguments, '{"path": "test.txt"}');

    // Verify usage
    assert.equal(result.usage.total_tokens, 30);
  });
});

describe('UX: Session Persistence and Resume', () => {
  const tempDir = path.resolve('test_sessions_temp');

  before(async () => {
    await fs.mkdir(tempDir, { recursive: true });
  });

  after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  test('creates, saves, restarts, and resumes session from disk', async () => {
    const sm1 = new SessionManager(tempDir);
    const session = sm1.createSession({
      mode: 'plan',
      model: 'test-model',
      messages: [
        { role: 'user', content: 'Initial question' },
        { role: 'assistant', content: 'Initial answer' }
      ]
    });

    session.addUsage({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
    await sm1.saveSession(session);

    // Simulate complete process restart with fresh SessionManager
    const sm2 = new SessionManager(tempDir);
    const loaded = await sm2.loadSession(session.id);

    assert.equal(loaded.id, session.id);
    assert.equal(loaded.mode, 'plan');
    assert.equal(loaded.model, 'test-model');
    assert.equal(loaded.messages.length, 2);
    assert.equal(loaded.usage.total_tokens, 150);

    const list = await sm2.listSessions();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, session.id);
    assert.equal(list[0].tokens, 150);
  });
});

describe('UX: Plan Mode (Read-Only) Enforcement', () => {
  test('PermissionManager blocks write_file and edit_file in plan mode', () => {
    const pm = new PermissionManager();

    const writeEval = pm.evaluate('write_file', { path: 'a.js' }, { mode: 'plan' });
    assert.equal(writeEval.action, 'deny');
    assert.match(writeEval.reason, /blocked in plan mode/);

    const editEval = pm.evaluate('edit_file', { path: 'a.js' }, { mode: 'plan' });
    assert.equal(editEval.action, 'deny');
    assert.match(editEval.reason, /blocked in plan mode/);

    const readEval = pm.evaluate('read_file', { path: 'a.js' }, { mode: 'plan' });
    assert.equal(readEval.action, 'allow');
  });

  test('runAgentLoop strictly rejects write_file in plan mode', async () => {
    let writeRan = false;
    const registry = new ToolRegistry();
    registry.register({
      name: 'write_file',
      description: 'write',
      async execute() {
        writeRan = true;
        return 'written';
      }
    });

    const messages = [{ role: 'user', content: 'create a file' }];
    const mockChat = async () => ({
      role: 'assistant',
      tool_calls: [
        {
          id: 'call_write_blocked',
          type: 'function',
          function: {
            name: 'write_file',
            arguments: JSON.stringify({ path: 'new.txt', content: 'data' })
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
        mode: 'plan',
        permissionManager: new PermissionManager()
      }
    });

    assert.equal(writeRan, false, 'write_file must NEVER execute in plan mode');
    const toolMsg = messages.find(m => m.role === 'tool');
    assert.ok(toolMsg);
    assert.match(toolMsg.content, /Tool "write_file" is blocked in plan mode/);
  });
});
