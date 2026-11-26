import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

export class Session {
  constructor({
    id,
    mode = 'build',
    model = '',
    createdAt = Date.now(),
    updatedAt = Date.now(),
    usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    messages = []
  } = {}) {
    this.id = id || `ses_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.mode = mode; // 'build' | 'plan' | 'auto'
    this.model = model;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
    this.usage = {
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || 0
    };
    this.messages = messages;
  }

  addUsage(usageData = {}) {
    const p = usageData.prompt_tokens || 0;
    const c = usageData.completion_tokens || 0;
    const t = usageData.total_tokens || (p + c);

    this.usage.prompt_tokens += p;
    this.usage.completion_tokens += c;
    this.usage.total_tokens += t;
    this.updatedAt = Date.now();
  }

  toJSON() {
    return {
      id: this.id,
      mode: this.mode,
      model: this.model,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      usage: this.usage,
      messages: this.messages
    };
  }
}

export class SessionManager {
  constructor(workingDir = process.cwd()) {
    this.workingDir = workingDir;
    this.sessionsDir = path.resolve(workingDir, '.agent', 'sessions');
  }

  async ensureDir() {
    await fs.mkdir(this.sessionsDir, { recursive: true });
  }

  ensureDirSync() {
    if (!fsSync.existsSync(this.sessionsDir)) {
      fsSync.mkdirSync(this.sessionsDir, { recursive: true });
    }
  }

  createSession(options = {}) {
    this.ensureDirSync();
    const session = new Session(options);
    this.saveSessionSync(session);
    return session;
  }

  getSessionPath(id) {
    const safeId = path.basename(id).replace(/[^a-zA-Z0-9_-]/g, '');
    return path.join(this.sessionsDir, `${safeId}.json`);
  }

  async saveSession(session) {
    await this.ensureDir();
    session.updatedAt = Date.now();
    const filePath = this.getSessionPath(session.id);
    await fs.writeFile(filePath, JSON.stringify(session.toJSON(), null, 2), 'utf8');
  }

  saveSessionSync(session) {
    this.ensureDirSync();
    session.updatedAt = Date.now();
    const filePath = this.getSessionPath(session.id);
    fsSync.writeFileSync(filePath, JSON.stringify(session.toJSON(), null, 2), 'utf8');
  }

  async loadSession(id) {
    const filePath = this.getSessionPath(id);
    try {
      const data = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(data);
      return new Session(parsed);
    } catch (err) {
      throw new Error(`Failed to load session "${id}": ${err.message}`);
    }
  }

  async listSessions() {
    await this.ensureDir();
    let files = [];
    try {
      files = await fs.readdir(this.sessionsDir);
    } catch {
      return [];
    }

    const sessions = [];
    for (const file of files) {
      if (file.endsWith('.json')) {
        try {
          const raw = await fs.readFile(path.join(this.sessionsDir, file), 'utf8');
          const parsed = JSON.parse(raw);
          sessions.push({
            id: parsed.id,
            mode: parsed.mode || 'build',
            model: parsed.model,
            messageCount: parsed.messages?.length || 0,
            tokens: parsed.usage?.total_tokens || 0,
            createdAt: parsed.createdAt,
            updatedAt: parsed.updatedAt
          });
        } catch {
          // Skip corrupt file
        }
      }
    }

    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    return sessions;
  }
}
