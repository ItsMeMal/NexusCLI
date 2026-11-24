import http from 'node:http';
import path from 'node:path';
import { runAgentLoop } from './core/loop.js';
import { createDefaultRegistry } from './tools/index.js';
import { ExtensionManager } from './core/extensions.js';
import { buildSystemPrompt } from './core/prompt.js';
import { SessionManager } from './core/session.js';
import { SessionSnapshotManager } from './core/snapshot.js';
import { loadEnv } from './core/config.js';
import { getDefaultModelSelection } from './core/providers/index.js';
import { estimateMessagesTokens, compactContextIfNeeded } from './core/context.js';

export function createNexusServer(options = {}) {
  const workingDir = options.workingDir || process.cwd();
  loadEnv(workingDir);

  const host = options.host || process.env.NEXUS_HOST || '127.0.0.1';
  const port = options.port ?? (process.env.NEXUS_PORT ? Number(process.env.NEXUS_PORT) : 4141);
  const token = options.token !== undefined ? options.token : (process.env.NEXUS_SERVER_TOKEN || null);

  const sessionManager = new SessionManager(workingDir);
  const snapshotManager = new SessionSnapshotManager(workingDir);
  const registry = options.registry || createDefaultRegistry();
  const extensionManager = options.extensionManager || new ExtensionManager(workingDir);
  let extensionStatus = null;
  let extensionInitPromise = null;

  async function initializeExtensions() {
    if (!extensionInitPromise) extensionInitPromise = extensionManager.initialize(registry);
    extensionStatus = await extensionInitPromise;
    return extensionStatus;
  }

  // SSE client connections by sessionId: Map<sessionId, Set<res>>
  const sseClients = new Map();
  // Pending permission requests by permId: Map<permId, { resolve: Function, sessionId: string }>
  const pendingPermissions = new Map();
  // Active loop runs by sessionId: Map<sessionId, { abortController: AbortController }>
  const activeRuns = new Map();

  function broadcastEvent(sessionId, event) {
    const clients = sseClients.get(sessionId);
    if (!clients || clients.size === 0) return;

    const eventType = event.type || 'message';
    const ssePayload = `event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`;

    for (const res of clients) {
      try {
        res.write(ssePayload);
      } catch {
        clients.delete(res);
      }
    }
  }

  function sendJson(res, statusCode, data) {
    const body = JSON.stringify(data);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-nexus-token',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    });
    res.end(body);
  }

  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 5 * 1024 * 1024) {
          req.destroy();
          reject(new Error('Payload too large'));
        }
      });
      req.on('end', () => {
        if (!body.trim()) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error(`Malformed JSON body: ${err.message}`));
        }
      });
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-nexus-token',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
      });
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url, `http://${host}:${port}`);
    const pathname = parsedUrl.pathname;

    // Authentication check
    if (token) {
      const authHeader = req.headers['authorization'] || req.headers['x-nexus-token'] || '';
      const tokenMatch = authHeader.replace(/^Bearer\s+/i, '').trim();
      if (tokenMatch !== token) {
        sendJson(res, 401, { error: 'Unauthorized: Invalid or missing authentication token' });
        return;
      }
    }

    try {
      // 1. POST /session -> create new session
      if (req.method === 'POST' && pathname === '/session') {
        const body = await readJsonBody(req);
        const mode = body.mode || 'build';
        const model = body.model || getDefaultModelSelection() || process.env.MODEL || '';

        const session = sessionManager.createSession({
          mode,
          model,
          messages: [
            { role: 'system', content: buildSystemPrompt({ workingDir, mode }) }
          ]
        });

        sendJson(res, 201, {
          id: session.id,
          mode: session.mode,
          model: session.model,
          createdAt: session.createdAt
        });
        return;
      }

      // 2. GET /session -> list all sessions
      if (req.method === 'GET' && pathname === '/session') {
        const list = await sessionManager.listSessions();
        sendJson(res, 200, list);
        return;
      }

      // 3. GET /session/:id -> get session details
      const sessionGetMatch = pathname.match(/^\/session\/([^/]+)$/);
      if (req.method === 'GET' && sessionGetMatch) {
        const sessionId = sessionGetMatch[1];
        try {
          const session = await sessionManager.loadSession(sessionId);
          sendJson(res, 200, session.toJSON());
        } catch (err) {
          sendJson(res, 404, { error: `Session not found: ${err.message}` });
        }
        return;
      }

      // 3b. PATCH /session/:id -> persist session settings
      const sessionUpdateMatch = pathname.match(new RegExp('^/session/([^/]+)$'));
      if (req.method === 'PATCH' && sessionUpdateMatch) {
        const sessionId = sessionUpdateMatch[1];
        if (activeRuns.has(sessionId)) {
          sendJson(res, 409, { error: 'Cannot update a session while it is running.' });
          return;
        }

        const body = await readJsonBody(req);
        if (body.mode !== undefined && !['plan', 'build'].includes(body.mode)) {
          sendJson(res, 400, { error: 'mode must be "plan" or "build".' });
          return;
        }
        if (body.model !== undefined && (typeof body.model !== 'string' || !body.model.trim())) {
          sendJson(res, 400, { error: 'model must be a non-empty string.' });
          return;
        }

        try {
          const session = await sessionManager.loadSession(sessionId);
          if (body.mode !== undefined) session.mode = body.mode;
          if (body.model !== undefined) session.model = body.model.trim();
          await sessionManager.saveSession(session);
          sendJson(res, 200, { id: session.id, mode: session.mode, model: session.model });
        } catch (err) {
          sendJson(res, 404, { error: `Session not found: ${err.message}` });
        }
        return;
      }

      // 4. GET /session/:id/events -> SSE endpoint
      const eventsMatch = pathname.match(/^\/session\/([^/]+)\/events$/);
      if (req.method === 'GET' && eventsMatch) {
        const sessionId = eventsMatch[1];

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*'
        });

        res.write(`: connected to session ${sessionId}\n\n`);

        if (!sseClients.has(sessionId)) {
          sseClients.set(sessionId, new Set());
        }
        sseClients.get(sessionId).add(res);

        req.on('close', () => {
          const clients = sseClients.get(sessionId);
          if (clients) {
            clients.delete(res);
            if (clients.size === 0) sseClients.delete(sessionId);
          }
        });
        return;
      }

      // 5. POST /session/:id/message -> send user message & start loop
      const messageMatch = pathname.match(/^\/session\/([^/]+)\/message$/);
      if (req.method === 'POST' && messageMatch) {
        const sessionId = messageMatch[1];
        const body = await readJsonBody(req);
        const content = body.content;

        if (!content || typeof content !== 'string') {
          sendJson(res, 400, { error: '"content" field is required and must be a string.' });
          return;
        }

        let session;
        try {
          session = await sessionManager.loadSession(sessionId);
        } catch {
          sendJson(res, 404, { error: `Session "${sessionId}" not found.` });
          return;
        }

        if (activeRuns.has(sessionId)) {
          sendJson(res, 409, { error: `Session "${sessionId}" is currently running another task. Abort it first or wait.` });
          return;
        }

        session.messages.push({ role: 'user', content });
        await sessionManager.saveSession(session);

        const abortController = new AbortController();
        activeRuns.set(sessionId, { abortController });

        // Respond immediately with accepted status
        sendJson(res, 202, {
          accepted: true,
          sessionId,
          status: 'running'
        });

        // Run agent loop asynchronously, broadcasting events to SSE
        const runPromise = (async () => {
          try {
            await runAgentLoop({
              messages: session.messages,
              registry,
              chatFn: options.chatFn,
              ctx: {
                cwd: workingDir,
                pluginManager: extensionManager.plugins,
                mode: session.mode,
                session,
                sessionManager,
                snapshotManager,
                abortSignal: abortController.signal,
                llmOptions: {
                  model: session.model
                },
                resolvePermission: async (permId, permData) => {
                  return new Promise((resolve) => {
                    const timeout = setTimeout(() => {
                      pendingPermissions.delete(permId);
                      resolve(false);
                    }, 120000); // 2 minute timeout

                    pendingPermissions.set(permId, {
                      resolve: (val) => {
                        clearTimeout(timeout);
                        resolve(val);
                      },
                      sessionId
                    });
                  });
                }
              },
              onEvent: (event) => {
                broadcastEvent(sessionId, event);
              }
            });
          } catch (loopErr) {
            broadcastEvent(sessionId, {
              type: 'error',
              message: loopErr.message
            });
          } finally {
            activeRuns.delete(sessionId);
            await sessionManager.saveSession(session);
          }
        })();
        const activeRun = activeRuns.get(sessionId);
        if (activeRun) activeRun.promise = runPromise;

        return;
      }

      // 6. POST /permission/:id -> answer permission request
      const permMatch = pathname.match(/^\/permission\/([^/]+)$/);
      if (req.method === 'POST' && permMatch) {
        const permId = permMatch[1];
        const body = await readJsonBody(req);
        const allow = Boolean(body.allow);

        const pending = pendingPermissions.get(permId);
        if (!pending) {
          sendJson(res, 404, { error: `No pending permission request found with ID "${permId}".` });
          return;
        }

        pendingPermissions.delete(permId);
        pending.resolve(allow);

        sendJson(res, 200, {
          id: permId,
          resolved: true,
          allow
        });
        return;
      }

      // 7. POST /session/:id/abort -> abort active run
      const abortMatch = pathname.match(/^\/session\/([^/]+)\/abort$/);
      if (req.method === 'POST' && abortMatch) {
        const sessionId = abortMatch[1];
        const active = activeRuns.get(sessionId);

        if (!active) {
          sendJson(res, 200, { aborted: false, message: 'Session is not currently running.' });
          return;
        }

        active.abortController.abort();
        activeRuns.delete(sessionId);
        broadcastEvent(sessionId, { type: 'done', reason: 'aborted' });

        sendJson(res, 200, { aborted: true, sessionId });
        return;
      }

      // 8. POST /session/:id/compact -> manually trigger context compaction
      const compactMatch = pathname.match(/^\/session\/([^/]+)\/compact$/);
      if (req.method === 'POST' && compactMatch) {
        const sessionId = compactMatch[1];
        try {
          const session = await sessionManager.loadSession(sessionId);
          const beforeTokens = estimateMessagesTokens(session.messages);
          const result = await compactContextIfNeeded(session.messages, session.model, { force: true });
          if (result && (result.compacted || result.pruned)) {
            session.messages = result.messages;
            await sessionManager.saveSession(session);
            const afterTokens = estimateMessagesTokens(session.messages);
            sendJson(res, 200, {
              success: true,
              compacted: true,
              beforeTokens,
              afterTokens,
              savedTokens: Math.max(0, beforeTokens - afterTokens)
            });
          } else {
            sendJson(res, 200, {
              success: true,
              compacted: false,
              beforeTokens,
              afterTokens: beforeTokens,
              message: 'Context history has few messages and is already compact.'
            });
          }
        } catch (err) {
          sendJson(res, 500, { error: `Compaction failed: ${err.message}` });
        }
        return;
      }

      // Not found
      sendJson(res, 404, { error: `Route not found: ${req.method} ${pathname}` });
    } catch (err) {
      sendJson(res, 500, { error: `Internal Server Error: ${err.message}` });
    }
  });

  return {
    server,
    host,
    port,
    token,
    registry,
    extensionManager,
    getExtensionStatus: () => extensionStatus,
    async start() {
      const extensions = await initializeExtensions();
      return new Promise((resolve, reject) => {
        server.listen(port, host, () => {
          const addr = server.address();
          const actualPort = typeof addr === 'object' && addr ? addr.port : port;
          const url = `http://${host}:${actualPort}`;
          resolve({ server, url, port: actualPort, extensions });
        });
        server.on('error', reject);
      });
    },
    async close() {
      // Close all SSE connections
      for (const [_, clientSet] of sseClients) {
        for (const client of clientSet) {
          try { client.end(); } catch {}
        }
      }
      sseClients.clear();

      const running = Array.from(activeRuns.values());
      for (const active of running) active.abortController.abort();

      // Resolve outstanding approval prompts so shutdown cannot wait for their timeout.
      for (const [permissionId, pending] of pendingPermissions) {
        pendingPermissions.delete(permissionId);
        pending.resolve(false);
      }
      await Promise.allSettled(running.map(active => active.promise).filter(Boolean));

      await new Promise((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
      });

      if (extensionInitPromise) {
        await extensionManager.shutdown();
        extensionInitPromise = null;
        extensionStatus = null;
      }
    }
  };
}

// Standalone execution: node src/server.js
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  const nexusServer = createNexusServer();
  const info = await nexusServer.start();
  console.log(`Nexus Server listening on ${info.url}`);
  if (nexusServer.token) {
    console.log(`Authentication required via token.`);
  }
}
