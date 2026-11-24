import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runAgentLoop } from '../src/core/loop.js';
import { ToolRegistry } from '../src/tools/index.js';

describe('runAgentLoop', () => {
  test('terminates immediately if assistant returns no tool_calls', async () => {
    const messages = [{ role: 'user', content: 'hello' }];

    const mockChat = async (msgs) => {
      return {
        role: 'assistant',
        content: 'Hello! How can I help you today?'
      };
    };

    const result = await runAgentLoop({
      messages,
      chatFn: mockChat
    });

    assert.equal(result.completed, true);
    assert.equal(result.steps, 1);
    assert.equal(result.finalMessage.content, 'Hello! How can I help you today?');
    assert.equal(messages.length, 2);
  });

  test('executes tool_calls and adds tool response message', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'add',
      description: 'Add two numbers',
      parameters: {
        type: 'object',
        properties: {
          a: { type: 'number' },
          b: { type: 'number' }
        }
      },
      async execute({ a, b }) {
        return String(a + b);
      }
    });

    const messages = [{ role: 'user', content: 'add 5 and 7' }];

    let turn = 0;
    const mockChat = async (msgs) => {
      turn++;
      if (turn === 1) {
        return {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'add',
                arguments: JSON.stringify({ a: 5, b: 7 })
              }
            }
          ]
        };
      }
      return {
        role: 'assistant',
        content: 'Result is 12.'
      };
    };

    const result = await runAgentLoop({
      messages,
      registry,
      chatFn: mockChat
    });

    assert.equal(result.completed, true);
    assert.equal(result.steps, 2);
    assert.equal(result.finalMessage.content, 'Result is 12.');

    // Check message history: [user, assistant(tool_calls), tool(result), assistant(final)]
    assert.equal(messages.length, 4);
    assert.equal(messages[2].role, 'tool');
    assert.equal(messages[2].tool_call_id, 'call_1');
    assert.equal(messages[2].content, '12');
  });

  test('gracefully handles broken/corrupted JSON arguments without crashing', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'dummy',
      description: 'A dummy tool',
      async execute(args) {
        return 'success';
      }
    });

    const messages = [{ role: 'user', content: 'run dummy' }];

    let turn = 0;
    let receivedToolMessageContent = null;

    const mockChat = async (msgs) => {
      turn++;
      if (turn === 1) {
        return {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_bad_json',
              type: 'function',
              function: {
                name: 'dummy',
                arguments: '{ broken json: "unclosed'
              }
            }
          ]
        };
      }
      // Inspect tool message that was fed back to model
      const toolMsg = msgs.find(m => m.role === 'tool' && m.tool_call_id === 'call_bad_json');
      receivedToolMessageContent = toolMsg?.content;

      return {
        role: 'assistant',
        content: 'I noticed the arguments were malformed JSON, stopping.'
      };
    };

    const result = await runAgentLoop({
      messages,
      registry,
      chatFn: mockChat
    });

    assert.equal(result.completed, true);
    assert.ok(receivedToolMessageContent, 'Tool message should be passed back');
    assert.match(receivedToolMessageContent, /Error: Invalid JSON arguments for tool "dummy"/);
    assert.equal(result.finalMessage.content, 'I noticed the arguments were malformed JSON, stopping.');
  });

  test('stops when reaching maxSteps', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'ping',
      description: 'ping',
      async execute() { return 'pong'; }
    });

    const messages = [{ role: 'user', content: 'loop forever' }];

    const mockChat = async () => {
      return {
        role: 'assistant',
        tool_calls: [
          {
            id: 'call_ping',
            type: 'function',
            function: {
              name: 'ping',
              arguments: '{}'
            }
          }
        ]
      };
    };

    const result = await runAgentLoop({
      messages,
      registry,
      chatFn: mockChat,
      maxSteps: 3
    });

    assert.equal(result.completed, false);
    assert.equal(result.reason, 'max_steps_reached');
    assert.equal(result.steps, 3);
  });
});
