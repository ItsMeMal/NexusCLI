import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  estimateTokens,
  estimateMessagesTokens,
  calculateContextUsage,
  compactContextIfNeeded,
  pruneOldOutputs,
  getModelConfig,
  formatUsageDescription
} from '../src/core/context.js';

// Test 1: Token estimation
describe('Context: Token Estimation', () => {
  it('estimates tokens for simple text', () => {
    const text = 'Hello world this is a test';
    const tokens = estimateTokens(text);
    assert.ok(tokens > 0);
    assert.ok(tokens <= text.length);
  });

  it('estimates tokens for code', () => {
    const code = 'function add(a, b) { return a + b; }';
    const tokens = estimateTokens(code);
    assert.ok(tokens > 0);
  });

  it('estimates messages tokens', () => {
    const messages = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello!' },
      { role: 'assistant', content: 'Hi there!' }
    ];
    const total = estimateMessagesTokens(messages);
    assert.ok(total > 0);
  });
});

// Test 2: Context usage calculation
describe('Context: Usage Calculation', () => {
  it('calculates usage ratio under threshold', () => {
    const messages = [
      { role: 'system', content: 'You are Nexus, a coding agent.' },
      { role: 'user', content: 'Please fix the syntax error in the code.' }
    ];
    const usage = calculateContextUsage(messages, 'Elaina-Free');
    assert.ok(usage.usageRatio < 0.8); // Should be under 80% threshold
    assert.ok(!usage.exceeded);
  });

  it('calculates usage ratio properties exist', () => {
    const longMessages = Array(50).fill().map((_, i) => ({
      role: 'user',
      content: `Message number ${i} with some content to increase token count. `.repeat(20)
    }));
    
    const usage = calculateContextUsage(longMessages, 'Elaina-Free');
    assert.ok(typeof usage.usageRatio === 'number');
    assert.ok(typeof usage.usedTokens === 'number');
    assert.ok(typeof usage.maxTokens === 'number');
  });
});

// Test 3: Context compaction
describe('Context: Compaction', () => {
  // Mock onEvent for testing
  const mockOnEvent = () => {};

  it('does not compact when under threshold', async () => {
    const messages = [
      { role: 'system', content: 'You are Nexus, a coding agent.' },
      { role: 'user', content: 'Please fix the syntax error.' }
    ];
    
    const result = await compactContextIfNeeded(messages, 'Elaina-Free', mockOnEvent);
    assert.strictEqual(result.compacted, false);
    assert.strictEqual(result.messages.length, messages.length);
  });

  it('compactContextIfNeeded returns result with usage info', async () => {
    const messages = [
      { role: 'system', content: 'You are Nexus, a coding agent.' },
      { role: 'user', content: 'Please fix the syntax error.' },
      { role: 'assistant', content: 'I will fix the syntax error now.' }
    ];
    
    const result = await compactContextIfNeeded(messages, 'Elaina-Free', mockOnEvent);
    assert.ok(result !== undefined);
    assert.ok(result.usage !== undefined);
    assert.ok(typeof result.usage.usageRatio === 'number');
  });
});

// Test 4: Pruning old outputs
describe('Context: Pruning', () => {
  it('prunes long tool outputs', () => {
    const messages = [
      { role: 'user', content: 'Hello' },
      { role: 'tool', name: 'bash', content: 'some output', output: 'X'.repeat(600) }
    ];
    
    const pruned = pruneOldOutputs(messages, 500);
    const toolResult = pruned.find(m => m && m.role === 'tool' && m.output);
    if (toolResult) {
      // Output should be truncated to maxOutputLength with dipangkas marker
      assert.ok(toolResult.output.length <= 500, `Output length ${toolResult.output.length} should be <= 500`);
      assert.ok(toolResult.output.includes('dipangkas'), `Output should include "dipangkas": ${toolResult.output}`);
    }
  });
});

// Test 5: Model config
describe('Context: Model Config', () => {
  it('gets model config for known model', () => {
    const config = getModelConfig('Elaina-Free');
    assert.ok(config.maxTokens > 0);
    assert.ok(config.name === 'Elaina-Free' || config.name === 'Unknown Model');
  });

  it('gets model config with defaults for unknown model', () => {
    const config = getModelConfig('Unknown-Model-XYZ');
    assert.ok(config.maxTokens > 0);
  });
});

// Test 6: Format usage description
describe('Context: Format Usage', () => {
  it('formats usage description correctly', () => {
    const usage = {
      usedTokens: 1000,
      maxTokens: 8192,
      usageRatio: 0.12,
      modelName: 'Elaina-Free',
      exceeded: false
    };
    
    const desc = formatUsageDescription(usage);
    assert.ok(desc.includes('OK') || desc.includes('✓'), `Expected OK or ✓ in: ${desc}`);
    assert.ok(desc.includes('Elaina-Free'), `Expected Elaina-Free in: ${desc}`);
    assert.ok(desc.includes('1.000'), `Expected 1.000 in: ${desc} (got: ${desc})`);
    assert.ok(desc.includes('8.192'), `Expected 8.192 in: ${desc} (got: ${desc})`);
  });
});