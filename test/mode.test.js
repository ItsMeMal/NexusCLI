import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAutoMode, isExecutionMode } from '../src/core/mode.js';

describe('Auto execution mode', () => {
  test('accepts plan, build, and auto only', () => {
    assert.equal(isExecutionMode('plan'), true);
    assert.equal(isExecutionMode('build'), true);
    assert.equal(isExecutionMode('auto'), true);
    assert.equal(isExecutionMode('unsafe'), false);
  });

  test('keeps questions and analysis on the read-only route', () => {
    assert.deepEqual(resolveAutoMode('auto', 'Explain how the provider registry works.'), {
      executionMode: 'plan',
      reason: 'safe_read_only_default'
    });
    assert.equal(resolveAutoMode('auto', 'Review this repository for security issues.').executionMode, 'plan');
  });

  test('routes clear English and Indonesian action requests to build', () => {
    assert.equal(resolveAutoMode('auto', 'Add a mascot to the terminal.').executionMode, 'build');
    assert.equal(resolveAutoMode('auto', 'Tolong perbaiki bug login.').executionMode, 'build');
    assert.equal(resolveAutoMode('auto', 'Run the test suite.').executionMode, 'build');
    assert.equal(resolveAutoMode('auto', 'tambah mascot dan tambah mode auto').executionMode, 'build');
  });

  test('an explicit read-only instruction wins over action wording', () => {
    assert.equal(resolveAutoMode('auto', 'Review and fix this, but do not modify any files.').executionMode, 'plan');
    assert.equal(resolveAutoMode('auto', 'Jangan ubah file, cukup analisis penyebabnya.').executionMode, 'plan');
  });

  test('manual modes always override Auto classification', () => {
    assert.equal(resolveAutoMode('plan', 'Create a file.').executionMode, 'plan');
    assert.equal(resolveAutoMode('build', 'Explain this code.').executionMode, 'build');
  });
});
