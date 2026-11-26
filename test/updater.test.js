import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CURRENT_VERSION, UPDATE_SOURCE, UPDATE_CHECK_URL, getUpdateCommand, getUpdatePlan, isVersionNewer, checkForUpdates, installLatestFromGitHub } from '../src/core/updater.js';

test('version comparison detects newer releases and stable releases over prereleases', () => {
  assert.equal(isVersionNewer('0.1.4', '0.1.3'), true);
  assert.equal(isVersionNewer('0.1.3', '0.1.3'), false);
  assert.equal(isVersionNewer('0.1.2', '0.1.3'), false);
  assert.equal(isVersionNewer('0.2.0', '0.10.0'), false);
  assert.equal(isVersionNewer('0.1.3', '0.1.3-rc.1'), true);
  assert.equal(isVersionNewer('0.1.3-rc.1', '0.1.3'), false);
});

test('update check reads GitHub main and caches a valid package version', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexuscode-update-'));
  const cachePath = path.join(dir, 'update-check.json');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  let requests = 0;
  const fetchImpl = async (url, options) => {
    requests++;
    assert.equal(url, UPDATE_CHECK_URL);
    assert.ok(options.signal);
    return new Response(JSON.stringify({ version: '9.9.9' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  const first = await checkForUpdates({ fetchImpl, cachePath, now: 1000000 });
  assert.equal(first.latestVersion, '9.9.9');
  assert.equal(first.updateAvailable, true);
  assert.equal(first.fromCache, false);

  const second = await checkForUpdates({
    fetchImpl: async () => { requests++; throw new Error('Should use cache'); },
    cachePath,
    now: 1000001
  });
  assert.equal(second.updateAvailable, true);
  assert.equal(second.fromCache, true);
  assert.equal(requests, 1);
});

test('disabled update checks do not display a cached update alert', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexuscode-update-disabled-'));
  const cachePath = path.join(dir, 'update-check.json');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(cachePath, JSON.stringify({ latestVersion: '9.9.9', checkedAt: 1000000 }));

  const previous = process.env.NEXUS_DISABLE_UPDATE_CHECK;
  process.env.NEXUS_DISABLE_UPDATE_CHECK = '1';
  try {
    const result = await checkForUpdates({
      fetchImpl: async () => { throw new Error('Disabled checks must not make network requests'); },
      cachePath,
      now: 1000001
    });
    assert.equal(result.disabled, true);
    assert.equal(result.updateAvailable, false);
    assert.equal(result.latestVersion, null);
  } finally {
    if (previous === undefined) delete process.env.NEXUS_DISABLE_UPDATE_CHECK;
    else process.env.NEXUS_DISABLE_UPDATE_CHECK = previous;
  }
});

test('source checkout update plan fast-forwards main before installing dependencies', async () => {
  const plan = getUpdatePlan({ platform: 'win32', sourceCheckout: true });
  assert.deepEqual(plan.map(item => item.stage), ['git-pull', 'dependencies']);
  assert.deepEqual(plan[0].args, ['pull', '--ff-only', 'origin', 'main']);
  assert.equal(plan[0].command, 'git');
  assert.equal(plan[1].command, 'npm.cmd');
  assert.deepEqual(plan[1].args, ['install']);
  assert.equal(plan[1].options.shell, true);
});

test('source checkout updater runs pull and dependency installation in sequence', async () => {
  const calls = [];
  const result = await installLatestFromGitHub({
    platform: 'linux',
    sourceCheckout: false,
    sourceCheckout: true,
    spawnImpl(command, args, options) {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      setImmediate(() => child.emit('close', 0, null));
      return child;
    }
  });

  assert.deepEqual(calls.map(call => call.command), ['git', 'npm']);
  assert.deepEqual(calls[0].args, ['pull', '--ff-only', 'origin', 'main']);
  assert.deepEqual(calls[1].args, ['install']);
  assert.equal(result.code, 0);
  assert.equal(result.sourceCheckout, true);
});

test('updater reports the 0.1.5 package version and targets the repository main branch', () => {
  assert.equal(CURRENT_VERSION, '0.1.5');
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
    sourceCheckout: false,
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
  assert.deepEqual(result, { code: 0, signal: null, sourceCheckout: false });
});
