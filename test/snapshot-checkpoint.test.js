import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPotentiallyMutatingTool } from '../src/core/snapshot.js';

test('post-turn checkpoint classifier skips known read-only tools', () => {
  for (const name of ['read_file', 'grep', 'glob', 'repo_map', 'webfetch', 'todo']) {
    assert.equal(isPotentiallyMutatingTool(name), false, name + ' should not trigger a workspace checkpoint');
  }
});

test('post-turn checkpoint classifier captures mutating and extension tools', () => {
  for (const name of ['write_file', 'edit_file', 'bash', 'task', 'mcp_write', 'custom_tool']) {
    assert.equal(isPotentiallyMutatingTool(name), true, name + ' should trigger a workspace checkpoint');
  }
});

test('post-turn checkpoint classifier handles empty and mixed-case tool names safely', () => {
  assert.equal(isPotentiallyMutatingTool(''), false);
  assert.equal(isPotentiallyMutatingTool(null), false);
  assert.equal(isPotentiallyMutatingTool('READ_FILE'), false);
  assert.equal(isPotentiallyMutatingTool('BASH'), true);
});
