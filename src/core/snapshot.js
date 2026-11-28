import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const READ_ONLY_TOOL_NAMES = new Set([
  'read_file',
  'grep',
  'glob',
  'repo_map',
  'webfetch',
  'todo'
]);

/**
 * Be conservative for extensions and unknown tools: they may mutate the workspace.
 * Only tools known to be read-only skip the post-turn workspace checkpoint.
 */
export function isPotentiallyMutatingTool(toolName) {
  const name = String(toolName || '').trim().toLowerCase();
  return Boolean(name) && !READ_ONLY_TOOL_NAMES.has(name);
}

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
    /** @type {{ ref: string, label: string, timestamp: number }[]} */
    this.checkpoints = [];
    /** Index pointing to current position in checkpoint stack. -1 = no checkpoints applied. */
    this.currentIndex = -1;
    this.initialRef = null;
    this.created = false;
  }

  async captureFirstSnapshot() {
    if (this.created) return this.initialRef;
    this.created = true;

    const isGit = await isGitRepo(this.workingDir);
    if (!isGit) return null;

    try {
      const { stdout: stashHash } = await execAsync('git stash create "nexus-session-snapshot"', {
        cwd: this.workingDir
      });
      let ref = stashHash.trim();
      if (!ref) {
        const { stdout: headHash } = await execAsync('git rev-parse HEAD', { cwd: this.workingDir });
        ref = headHash.trim();
      }
      this.initialRef = ref;

      this.checkpoints = [{
        ref,
        label: 'session-start',
        timestamp: Date.now()
      }];
      this.currentIndex = 0;

      return { ref, workingDir: this.workingDir, timestamp: Date.now() };
    } catch (err) {
      console.warn(`[Snapshot] Could not create git snapshot: ${err.message}`);
      return null;
    }
  }

  /**
   * Create a new checkpoint of current working directory state.
   * @param {string} [label] - Optional human-readable label.
   */
  async createCheckpoint(label = '') {
    const isGit = await isGitRepo(this.workingDir);
    if (!isGit) return { success: false, message: 'Not a git repository.' };

    try {
      // Stage all changes so stash create captures everything
      await execAsync('git add -A', { cwd: this.workingDir });

      const { stdout: stashHash } = await execAsync('git stash create "nexus-checkpoint"', {
        cwd: this.workingDir
      });
      let ref = stashHash.trim();
      if (!ref) {
        const { stdout: headHash } = await execAsync('git rev-parse HEAD', { cwd: this.workingDir });
        ref = headHash.trim();
      }

      // Trim any redo history beyond current position
      this.checkpoints = this.checkpoints.slice(0, this.currentIndex + 1);

      const cp = {
        ref,
        label: label || `checkpoint-${this.checkpoints.length}`,
        timestamp: Date.now()
      };
      this.checkpoints.push(cp);
      this.currentIndex = this.checkpoints.length - 1;

      return { success: true, index: this.currentIndex, ref: ref.slice(0, 8), label: cp.label };
    } catch (err) {
      return { success: false, message: `Failed to create checkpoint: ${err.message}` };
    }
  }

  /**
   * Undo: move backward one checkpoint.
   */
  async undo() {
    if (this.checkpoints.length === 0) {
      return { success: false, message: 'No checkpoints. Nothing to undo.' };
    }
    if (this.currentIndex <= 0) {
      return { success: false, message: 'Already at earliest checkpoint. Cannot undo further.' };
    }

    // Before undoing, auto-save current state so redo can return here
    await this._autoSaveCurrentState();

    this.currentIndex--;
    return this._restoreToIndex(this.currentIndex, 'undo');
  }

  /**
   * Redo: move forward one checkpoint.
   */
  async redo() {
    if (this.currentIndex >= this.checkpoints.length - 1) {
      return { success: false, message: 'No redo history available.' };
    }
    this.currentIndex++;
    return this._restoreToIndex(this.currentIndex, 'redo');
  }

  /**
   * Restore to specific checkpoint index.
   */
  async restoreToCheckpoint(index) {
    if (index < 0 || index >= this.checkpoints.length) {
      return { success: false, message: `Invalid checkpoint index: ${index}. Available: 0-${this.checkpoints.length - 1}` };
    }
    this.currentIndex = index;
    return this._restoreToIndex(index, 'restore');
  }

  /**
   * Legacy restore() — goes to initial checkpoint.
   */
  async restore() {
    if (!this.initialRef) {
      return { success: false, message: 'No snapshot found for this session. Nothing to undo.' };
    }
    this.currentIndex = 0;
    return this._restoreToIndex(0, 'undo');
  }

  /**
   * List all checkpoints with their status.
   */
  listCheckpoints() {
    return this.checkpoints.map((cp, i) => ({
      index: i,
      ref: cp.ref.slice(0, 8),
      label: cp.label,
      timestamp: cp.timestamp,
      current: i === this.currentIndex
    }));
  }

  /** @private */
  async _autoSaveCurrentState() {
    try {
      await execAsync('git add -A', { cwd: this.workingDir });
      const { stdout: stashHash } = await execAsync('git stash create "nexus-auto-save"', {
        cwd: this.workingDir
      });
      let ref = stashHash.trim();
      if (!ref) {
        // No changes from current checkpoint — no need to save
        return;
      }

      // If currentIndex is not at the end, replace current entry's ref with latest state
      if (this.currentIndex >= 0 && this.currentIndex < this.checkpoints.length) {
        this.checkpoints[this.currentIndex] = {
          ...this.checkpoints[this.currentIndex],
          ref
        };
      }
    } catch {
      // Best-effort
    }
  }

  /**
   * Get git diff of current changes against initial checkpoint or HEAD.
   */
  async getDiff() {
    const isGit = await isGitRepo(this.workingDir);
    if (!isGit) return { success: false, message: 'Not a git repository.' };

    try {
      // First try diff against initial snapshot ref if available
      const compareRef = this.initialRef || 'HEAD';
      const { stdout: diffOutput } = await execAsync(`git diff ${compareRef}`, { cwd: this.workingDir });
      const { stdout: statusOutput } = await execAsync('git status --short', { cwd: this.workingDir });

      return {
        success: true,
        diff: diffOutput.trim(),
        status: statusOutput.trim(),
        compareRef: compareRef.slice(0, 8)
      };
    } catch (err) {
      // Fallback to plain working tree diff
      try {
        const { stdout: diffOutput } = await execAsync('git diff HEAD', { cwd: this.workingDir });
        const { stdout: statusOutput } = await execAsync('git status --short', { cwd: this.workingDir });
        return {
          success: true,
          diff: diffOutput.trim(),
          status: statusOutput.trim(),
          compareRef: 'HEAD'
        };
      } catch (fallbackErr) {
        return { success: false, message: `Could not compute diff: ${fallbackErr.message}` };
      }
    }
  }

  /**
   * Get current active git branch name
   */
  async getCurrentBranch() {
    const isGit = await isGitRepo(this.workingDir);
    if (!isGit) return 'no-git';
    try {
      const { stdout } = await execAsync('git branch --show-current', { cwd: this.workingDir });
      return stdout.trim() || 'detached';
    } catch {
      return 'unknown';
    }
  }

  /** @private */
  async _restoreToIndex(index, action) {
    const cp = this.checkpoints[index];
    if (!cp) {
      return { success: false, message: `Checkpoint ${index} not found.` };
    }

    try {
      await execAsync(`git checkout ${cp.ref} -- .`, { cwd: this.workingDir });
      await execAsync('git clean -fd', { cwd: this.workingDir });

      return {
        success: true,
        message: `[${action}] Restored to checkpoint ${index} "${cp.label}" (${cp.ref.slice(0, 8)}).`,
        index,
        label: cp.label
      };
    } catch (err) {
      return {
        success: false,
        message: `Failed to ${action} to checkpoint ${index}: ${err.message}`
      };
    }
  }
}
