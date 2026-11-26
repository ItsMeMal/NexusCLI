import { exec } from 'node:child_process';

function killProcessTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      exec(`taskkill /pid ${pid} /T /F`, () => {});
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch { process.kill(pid, 'SIGKILL'); }
    }
  } catch {}
}

export async function isDockerAvailable() {
  return new Promise((resolve) => {
    exec('docker --version', { windowsHide: true }, (err) => {
      resolve(!err);
    });
  });
}

export function buildDockerCommand(command, cwd) {
  // Mount working dir to /workspace, no network, read-write.
  const escapedCwd = cwd.replace(/\\/g, '/');
  return `docker run --rm --network none -v "${escapedCwd}:/workspace" -w /workspace alpine:latest sh -c ${JSON.stringify(command)}`;
}

export async function executeBash(command, ctx = {}) {
  const cwd = ctx.cwd || process.cwd();
  const timeout = ctx.timeout || 60000;
  const signal = ctx.abortSignal;
  const useDocker = ctx.sandbox === 'docker' || process.env.NEXUS_BASH_SANDBOX === 'docker';

  if (signal?.aborted) return 'Error: Command cancelled by user.';

  let actualCommand = command;
  let actualCwd = cwd;
  if (useDocker) {
    const available = await isDockerAvailable();
    if (signal?.aborted) return 'Error: Command cancelled by user.';
    if (available) {
      actualCommand = buildDockerCommand(command, cwd);
      actualCwd = process.cwd(); // docker handles cwd
    }
  }

  return new Promise((resolve) => {
    let timedOut = false;
    let cancelled = false;
    let timer = null;
    let child;

    const onAbort = () => {
      cancelled = true;
      if (child?.pid) killProcessTree(child.pid);
    };
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    child = exec(
      actualCommand,
      {
        cwd: actualCwd,
        timeout,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
        detached: process.platform !== 'win32'
      },
      (err, stdout, stderr) => {
        cleanup();
        const out = (stdout || '').replace(/\x1B\[[0-9;]*m/g, '').trim();
        const errOutput = (stderr || '').trim();

        if (cancelled) {
          let msg = 'Error: Command cancelled by user.';
          if (out) msg += '\n[stdout before cancellation]:\n' + out;
          if (errOutput) msg += '\n[stderr before cancellation]:\n' + errOutput;
          resolve(msg);
          return;
        }
        if (timedOut || (err && (err.killed || err.signal === 'SIGTERM' || err.signal === 'SIGKILL'))) {
          let msg = 'Error: Command timed out after ' + timeout + 'ms and was killed.';
          if (out) msg += '\n[stdout before timeout]:\n' + out;
          resolve(msg);
          return;
        }
        if (err) {
          let msg = 'Command failed: ' + err.message;
          if (out) msg += '\n[stdout]:\n' + out;
          if (errOutput) msg += '\n[stderr]:\n' + errOutput;
          resolve(msg);
          return;
        }
        if (!out && !errOutput) {
          resolve('(Command finished with no output)');
          return;
        }
        if (out && errOutput) {
          resolve(out + '\n[stderr]:\n' + errOutput);
          return;
        }
        resolve(out || errOutput);
      }
    );

    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();

    timer = setTimeout(() => {
      timedOut = true;
      if (child?.pid) killProcessTree(child.pid);
    }, timeout + 500);
  });
}
