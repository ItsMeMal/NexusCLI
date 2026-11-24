import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execAsync = promisify(exec);

export async function isGitRepo(workingDir = process.cwd()) {
  try {
    const gitDir = path.join(workingDir, '.git');
    if (fs.existsSync(gitDir)) return true;
    const { stdout } = await execAsync('git rev-parse --is-inside-work-tree', { cwd: workingDir });
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

export class SessionSnapshotManager {
  constructor(workingDir = process.cwd()) {
    this.workingDir = workingDir;
    this.snapshot = null;
    this.created = false;
  }

  async captureFirstSnapshot() {
    if (this.created) return this.snapshot;
    this.created = true;

    const isGit = await isGitRepo(this.workingDir);
    if (!isGit) {
      return null;
    }

    try {
      // Try to create stash commit of current uncommitted state (without clearing worktree)
      const { stdout: stashHash } = await execAsync('git stash create "nexus-session-snapshot"', {
        cwd: this.workingDir
      });

      let ref = stashHash.trim();

      if (!ref) {
        // Working directory was clean; record current HEAD commit
        const { stdout: headHash } = await execAsync('git rev-parse HEAD', {
          cwd: this.workingDir
        });
        ref = headHash.trim();
      }

      this.snapshot = {
        ref,
        workingDir: this.workingDir,
        timestamp: Date.now()
      };

      return this.snapshot;
    } catch (err) {
      console.warn(`[Snapshot] Could not create git snapshot: ${err.message}`);
      return null;
    }
  }

  async restore() {
    if (!this.snapshot || !this.snapshot.ref) {
      return {
        success: false,
        message: 'No snapshot found for this session. Nothing to undo.'
      };
    }

    try {
      // Revert files to snapshot ref
      await execAsync(`git checkout ${this.snapshot.ref} -- .`, { cwd: this.workingDir });
      // Remove untracked files created during the session
      await execAsync('git clean -fd', { cwd: this.workingDir });

      return {
        success: true,
        message: `Working directory successfully restored to snapshot (${this.snapshot.ref.slice(0, 8)}).`
      };
    } catch (err) {
      return {
        success: false,
        message: `Failed to restore snapshot: ${err.message}`
      };
    }
  }
}
