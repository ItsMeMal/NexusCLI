import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CURRENT_VERSION, UPDATE_SOURCE, getUpdateCommand, installLatestFromGitHub } from '../src/core/updater.js';

test('updater reports the 0.1.3 package version and targets the repository main branch', () => {
  assert.equal(CURRENT_VERSION, '0.1.3');
  assert.equal(UPDATE_SOURCE, 'github:ItsMeMal/NexusCode#main');

  const unix = getUpdateCommand('linux');
  assert.equal(unix.command, 'npm');
  assert.deepEqual(unix.args, ['install', '--global', UPDATE_SOURCE]);

  const windows = getUpdateCommand('win32');
  assert.equal(windows.command, 'npm.cmd');
  assert.equal(windows.options.shell, true);
});

test('update installer reports the npm exit status without invoking a real process', async () => {
  let received;
  const result = await installLatestFromGitHub({
    platform: 'linux',
    spawnImpl(command, args, options) {
      received = { command, args, options };
      const child = new EventEmitter();
      setImmediate(() => child.emit('close', 0, null));
      return child;
    }
  });

  assert.equal(received.command, 'npm');
  assert.deepEqual(received.args, ['install', '--global', UPDATE_SOURCE]);
  assert.equal(received.options.stdio, 'inherit');
  assert.deepEqual(result, { code: 0, signal: null });
});
