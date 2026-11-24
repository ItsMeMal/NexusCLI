import { describe, it } from 'node:test';
import assert from 'node:assert';
import { todoTool } from '../src/tools/todo.js';
import { webfetchTool, htmlToText } from '../src/tools/webfetch.js';
import { runAgentLoop } from '../src/core/loop.js';
import { ToolRegistry } from '../src/tools/index.js';

describe('Tool: todo', () => {
  it('adds and lists tasks correctly', async () => {
    const ctx = { todos: [] };
    const resAdd = await todoTool.execute({ action: 'add', task: 'Review pull request' }, ctx);
    assert.match(resAdd, /Added task #1/);
    assert.strictEqual(ctx.todos.length, 1);
    assert.strictEqual(ctx.todos[0].task, 'Review pull request');
    assert.strictEqual(ctx.todos[0].status, 'pending');

    const resList = await todoTool.execute({ action: 'list' }, ctx);
    assert.match(resList, /1\. \[ \] Review pull request/);
    assert.match(resList, /Progress: 0\/1 completed/);
  });

  it('updates task status and completion progress', async () => {
    const ctx = { todos: [] };
    await todoTool.execute({ action: 'add', task: 'Write tests' }, ctx);
    await todoTool.execute({ action: 'add', task: 'Deploy code' }, ctx);

    const resUpdate = await todoTool.execute({ action: 'update', id: 1, status: 'done' }, ctx);
    assert.match(resUpdate, /Updated task #1.*\[x\]/);
    assert.strictEqual(ctx.todos[0].status, 'done');

    const resList = await todoTool.execute({ action: 'list' }, ctx);
    assert.match(resList, /Progress: 1\/2 completed/);
  });

  it('handles errors for invalid actions and bounds', async () => {
    const ctx = { todos: [] };
    const resEmpty = await todoTool.execute({ action: 'add', task: '' }, ctx);
    assert.match(resEmpty, /Error: "task" parameter is required/);

    const resBadId = await todoTool.execute({ action: 'update', id: 99, status: 'done' }, ctx);
    assert.match(resBadId, /Error: Valid "id"/);

    const resUnknown = await todoTool.execute({ action: 'delete' }, ctx);
    assert.match(resUnknown, /Error: Unknown action/);
  });

  it('clears todo list', async () => {
    const ctx = { todos: [{ id: 1, task: 'Sample', status: 'pending' }] };
    const resClear = await todoTool.execute({ action: 'clear' }, ctx);
    assert.match(resClear, /Todo list cleared/);
    assert.strictEqual(ctx.todos.length, 0);
  });
});

describe('Tool: webfetch & htmlToText', () => {
  it('converts HTML tags and entities to clean plain text', () => {
    const html = `
      <html>
        <head><title>Test Page</title><style>.hidden { display: none; }</style></head>
        <body>
          <script>console.log('ignore');</script>
          <h1>API Documentation &amp; Guide</h1>
          <p>This is a <b>fast</b> &lt;agent&gt; test &quot;runner&quot;.</p>
          <ul>
            <li>Feature 1</li>
            <li>Feature 2</li>
          </ul>
        </body>
      </html>
    `;
    const text = htmlToText(html);
    assert.doesNotMatch(text, /<script>/);
    assert.doesNotMatch(text, /console\.log/);
    assert.doesNotMatch(text, /<style>/);
    assert.match(text, /API Documentation & Guide/);
    assert.match(text, /fast <agent> test "runner"/);
    assert.match(text, /Feature 1/);
  });

  it('rejects invalid or non-http protocols', async () => {
    const res1 = await webfetchTool.execute({ url: 'file:///etc/passwd' });
    assert.match(res1, /Error: Unsupported protocol/);

    const res2 = await webfetchTool.execute({ url: 'not-a-valid-url' });
    assert.match(res2, /Error: Invalid URL/);
  });
});

describe('Core: Loop Detection', () => {
  it('detects and blocks 3 identical consecutive tool calls', async () => {
    const registry = new ToolRegistry();
    let callCount = 0;
    registry.register({
      name: 'repeat_probe',
      description: 'Test repeat',
      parameters: { type: 'object' },
      async execute(args) {
        callCount++;
        return `Result #${callCount}`;
      }
    });

    // Chat mock yang memanggil repeat_probe dengan argumen sama terus menerus
    let turns = 0;
    const mockChat = async () => {
      turns++;
      if (turns <= 4) {
        return {
          role: 'assistant',
          tool_calls: [
            {
              id: `call_${turns}`,
              type: 'function',
              function: {
                name: 'repeat_probe',
                arguments: JSON.stringify({ query: 'ping' })
              }
            }
          ]
        };
      }
      return {
        role: 'assistant',
        content: 'Stopped looping and finished.'
      };
    };

    const events = [];
    const res = await runAgentLoop({
      messages: [{ role: 'user', content: 'trigger loop' }],
      registry,
      chatFn: mockChat,
      onEvent: (ev) => events.push(ev),
      ctx: { autoApprove: true }
    });

    // Panggilan ke-1 & ke-2 dieksekusi (callCount = 2)
    // Panggilan ke-3 & ke-4 dideteksi sebagai loop dan DIBLOKIR tanpa memanggil execute
    assert.strictEqual(callCount, 2, 'Execution of tool must be blocked on 3rd identical call');

    // Cek pesan peringatan loop di messages
    const toolMsgs = res.messages.filter(m => m.role === 'tool');
    assert.ok(toolMsgs.length >= 3);
    assert.match(toolMsgs[2].content, /Warning: Loop detected/);

    // Cek event loop.detected ter-emit
    const loopEvent = events.find(e => e.type === 'loop.detected');
    assert.ok(loopEvent, 'Must emit loop.detected event');
    assert.strictEqual(loopEvent.name, 'repeat_probe');
    assert.strictEqual(loopEvent.consecutiveCount, 3);
  });
});
