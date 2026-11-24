import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));

export const CURRENT_VERSION = packageJson.version;
export const UPDATE_SOURCE = 'github:ItsMeMal/NexusCode#main';

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

export function installLatestFromGitHub({ platform = process.platform, spawnImpl = spawn } = {}) {
  const { command, args, options } = getUpdateCommand(platform);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(command, args, options);
    } catch (error) {
      reject(error);
      return;
    }

    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolve({ code: Number.isInteger(code) ? code : 1, signal: signal || null });
    });
  });
}
