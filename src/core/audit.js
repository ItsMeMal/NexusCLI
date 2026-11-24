import fs from 'node:fs';
import path from 'node:path';
import { redactObject, redactSecrets } from './secrets.js';

export function getAuditLogPath(workingDir = process.cwd()) {
  return path.join(workingDir, '.agent', 'audit.log');
}

export function appendAuditEntry(workingDir, entry) {
  const logPath = getAuditLogPath(workingDir);
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const safeEntry = {
      timestamp: new Date().toISOString(),
      tool: entry.tool,
      args: redactObject(entry.args || {}),
      result: entry.result ? redactSecrets(String(entry.result).slice(0, 500)) : undefined,
      allowed: entry.allowed,
      step: entry.step,
      externalContentRead: entry.externalContentRead
    };
    fs.appendFileSync(logPath, JSON.stringify(safeEntry) + '\n', 'utf8');
  } catch {
    // Never crash on audit failure
  }
}

export default { getAuditLogPath, appendAuditEntry };