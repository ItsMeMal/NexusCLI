import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));

export const CURRENT_VERSION = packageJson.version;
export const UPDATE_SOURCE = 'github:ItsMeMal/NexusCode#main';
export const UPDATE_CHECK_URL = 'https://raw.githubusercontent.com/ItsMeMal/NexusCode/main/package.json';
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const IS_SOURCE_CHECKOUT = fs.existsSync(path.join(packageRoot, '.git'));

function parseVersion(value) {
  const match = String(value || '').trim().replace(/^v/i, '')
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    numbers: match.slice(1, 4).map(Number),
    prerelease: match[4] ? match[4].split('.') : null
  };
}

export function isVersionNewer(candidate, current) {
  const next = parseVersion(candidate);
  const installed = parseVersion(current);
  if (!next || !installed) return false;

  for (let index = 0; index < 3; index++) {
    if (next.numbers[index] !== installed.numbers[index]) {
      return next.numbers[index] > installed.numbers[index];
    }
  }

  if (!next.prerelease && installed.prerelease) return true;
  if (next.prerelease && !installed.prerelease) return false;
  if (!next.prerelease && !installed.prerelease) return false;

  const length = Math.max(next.prerelease.length, installed.prerelease.length);
  for (let index = 0; index < length; index++) {
    const a = next.prerelease[index];
    const b = installed.prerelease[index];
    if (a === undefined) return false;
    if (b === undefined) return true;
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return Number(a) > Number(b);
    if (aNumeric !== bNumeric) return !aNumeric;
    return a > b;
  }
  return false;
}

function getUpdateCachePath() {
  const configDir = process.env.NEXUS_CONFIG_DIR || path.join(os.homedir(), '.nexuscli');
  return path.join(configDir, 'update-check.json');
}

function readUpdateCache(cachePath) {
  try {
    const value = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (typeof value.latestVersion !== 'string' || !parseVersion(value.latestVersion)) return null;
    if (!Number.isFinite(value.checkedAt)) return null;
    return value;
  } catch {
    return null;
  }
}

function writeUpdateCache(cachePath, value) {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(cachePath, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  } catch {
    // Update checks must never prevent NexusCode from starting.
  }
}

export async function checkForUpdates({
  fetchImpl = globalThis.fetch,
  cachePath = getUpdateCachePath(),
  now = Date.now(),
  intervalMs = UPDATE_CHECK_INTERVAL_MS,
  timeoutMs = 2200
} = {}) {
  const cached = readUpdateCache(cachePath);
  if (cached && now - cached.checkedAt < intervalMs && now >= cached.checkedAt) {
    return {
      currentVersion: CURRENT_VERSION,
      latestVersion: cached.latestVersion,
      updateAvailable: isVersionNewer(cached.latestVersion, CURRENT_VERSION),
      checkedAt: cached.checkedAt,
      checked: true,
      fromCache: true
    };
  }

  if (process.env.NEXUS_DISABLE_UPDATE_CHECK === '1' || typeof fetchImpl !== 'function') {
    return {
      currentVersion: CURRENT_VERSION,
      latestVersion: cached?.latestVersion || null,
      updateAvailable: cached ? isVersionNewer(cached.latestVersion, CURRENT_VERSION) : false,
      checkedAt: cached?.checkedAt || null,
      checked: false,
      disabled: true
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(UPDATE_CHECK_URL, {
      headers: { accept: 'application/json', 'user-agent': 'NexusCode-CLI/' + CURRENT_VERSION },
      signal: controller.signal
    });
    if (!response.ok) throw new Error('Version check returned HTTP ' + response.status);
    const manifest = await response.json();
    const latestVersion = String(manifest?.version || '').trim();
    if (!parseVersion(latestVersion)) throw new Error('Remote package manifest has an invalid version.');

    const value = { latestVersion, checkedAt: now };
    writeUpdateCache(cachePath, value);
    return {
      currentVersion: CURRENT_VERSION,
      latestVersion,
      updateAvailable: isVersionNewer(latestVersion, CURRENT_VERSION),
      checkedAt: now,
      checked: true,
      fromCache: false
    };
  } catch {
    return {
      currentVersion: CURRENT_VERSION,
      latestVersion: cached?.latestVersion || null,
      updateAvailable: cached ? isVersionNewer(cached.latestVersion, CURRENT_VERSION) : false,
      checkedAt: cached?.checkedAt || null,
      checked: false,
      fromCache: Boolean(cached),
      stale: Boolean(cached)
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function getUpdateCommand(platform = process.platform) {
  return {
    command: platform === 'win32' ? 'npm.cmd' : 'npm',
    args: ['install', '--global', UPDATE_SOURCE],
    options: {
      shell: platform === 'win32',
      windowsHide: true,
      stdio: 'inherit'
    }
  };
}

export function getUpdatePlan({ platform = process.platform, sourceCheckout = IS_SOURCE_CHECKOUT } = {}) {
  if (!sourceCheckout) return [{ stage: 'global-install', ...getUpdateCommand(platform) }];

  return [
    {
      stage: 'git-pull',
      command: 'git',
      args: ['pull', '--ff-only', 'origin', 'main'],
      options: { cwd: packageRoot, windowsHide: true, stdio: 'inherit' }
    },
    {
      stage: 'dependencies',
      command: platform === 'win32' ? 'npm.cmd' : 'npm',
      args: ['install'],
      options: { cwd: packageRoot, shell: platform === 'win32', windowsHide: true, stdio: 'inherit' }
    }
  ];
}

function runCommand(command, args, options, spawnImpl) {
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    const finish = (result, error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(result);
    };

    try {
      child = spawnImpl(command, args, options);
    } catch (error) {
      finish(null, error);
      return;
    }

    child.once('error', error => finish(null, error));
    child.once('close', (code, signal) => finish({
      code: Number.isInteger(code) ? code : 1,
      signal: signal || null
    }));
  });
}

export async function installLatestFromGitHub({
  platform = process.platform,
  spawnImpl = spawn,
  sourceCheckout = IS_SOURCE_CHECKOUT
} = {}) {
  const plan = getUpdatePlan({ platform, sourceCheckout });
  for (const step of plan) {
    const { stage, command, args, options } = step;
    const result = await runCommand(command, args, options, spawnImpl);
    if (result.code !== 0) return { ...result, stage };
  }
  return { code: 0, signal: null, sourceCheckout };
}
