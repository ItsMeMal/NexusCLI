import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createNexusServer } from '../src/server.js';

describe('Server: REST and SSE Architecture', () => {
  const tempDir = path.resolve('test_server_sandbox');
  let nexusServer;
  let serverUrl;
  const testToken = 'nexus-secret-123';

  before(async () => {
    await fs.mkdir(tempDir, { recursive: true });

    nexusServer = createNexusServer({
      port: 0,
      host: '127.0.0.1',
      token: testToken,
      workingDir: tempDir
    });

    const info = await nexusServer.start();
    serverUrl = info.url;
  });

  after(async () => {
    if (nexusServer) {
      await nexusServer.close();
    }
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  test('enforces token authentication', async () => {
    // Missing token
    const resNoAuth = await fetch(`${serverUrl}/session`);
    assert.equal(resNoAuth.status, 401);

    // Invalid token
    const resBadAuth = await fetch(`${serverUrl}/session`, {
      headers: { 'Authorization': 'Bearer wrong-token' }
    });
    assert.equal(resBadAuth.status, 401);

    // Valid token
    const resGoodAuth = await fetch(`${serverUrl}/session`, {
      headers: { 'Authorization': `Bearer ${testToken}` }
    });
    assert.equal(resGoodAuth.status, 200);
  });

  test('POST /session creates session and GET /session lists it', async () => {
    const postRes = await fetch(`${serverUrl}/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify({ mode: 'plan', model: 'test-model' })
    });

    assert.equal(postRes.status, 201);
    const sessionData = await postRes.json();
    assert.ok(sessionData.id);
    assert.equal(sessionData.mode, 'plan');
    assert.equal(sessionData.model, 'test-model');

    const getRes = await fetch(`${serverUrl}/session`, {
      headers: { 'Authorization': `Bearer ${testToken}` }
    });
    const list = await getRes.json();
    assert.ok(Array.isArray(list));
    const found = list.find(s => s.id === sessionData.id);
    assert.ok(found);
  });

  test('GET /session/:id/events streams SSE events from POST /session/:id/message', async () => {
    // 1. Create a session
    const createRes = await fetch(`${serverUrl}/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify({ mode: 'build' })
    });
    const { id: sessionId } = await createRes.json();

    // 2. Connect to SSE stream
    const sseRes = await fetch(`${serverUrl}/session/${sessionId}/events`, {
      headers: { 'Authorization': `Bearer ${testToken}` }
    });
    assert.equal(sseRes.status, 200);
    assert.match(sseRes.headers.get('content-type'), /text\/event-stream/);

    const reader = sseRes.body.getReader();
    const decoder = new TextDecoder();

    // 3. Send message to session
    const msgRes = await fetch(`${serverUrl}/session/${sessionId}/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify({ content: 'Ping server' })
    });
    assert.equal(msgRes.status, 202);

    // 4. Read incoming SSE events
    let receivedEvents = [];
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          const evType = line.slice(7).trim();
          receivedEvents.push(evType);
          if (evType === 'done' || evType === 'error') {
            await reader.cancel();
            break;
          }
        }
      }

      if (receivedEvents.includes('done') || receivedEvents.includes('error')) {
        break;
      }
    }

    assert.ok(receivedEvents.length > 0, 'Should receive SSE events from session loop');
  });

  test('POST /permission/:id resolves permission request', async () => {
    const fakeId = 'perm_test_123';
    // When no request exists, returns 404
    const res = await fetch(`${serverUrl}/permission/${fakeId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify({ allow: true })
    });

    assert.equal(res.status, 404);
  });

  test('POST /session/:id/abort aborts active session', async () => {
    const createRes = await fetch(`${serverUrl}/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify({ mode: 'build' })
    });
    const { id: sessionId } = await createRes.json();

    const abortRes = await fetch(`${serverUrl}/session/${sessionId}/abort`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${testToken}` }
    });
    assert.equal(abortRes.status, 200);
    const data = await abortRes.json();
    assert.equal(data.aborted, false); // Idle session has nothing to abort
  });
  test('keeps an interrupted run registered until it stops', async (t) => {
    const abortDir = path.join(tempDir, 'abort-active');
    await fs.mkdir(abortDir, { recursive: true });

    let signalStarted;
    const started = new Promise(resolve => { signalStarted = resolve; });
    const abortServer = createNexusServer({
      port: 0,
      host: '127.0.0.1',
      token: testToken,
      workingDir: abortDir,
      chatFn: async (_messages, _tools, options) => {
        signalStarted();
        return new Promise((resolve, reject) => {
          const abort = () => {
            setTimeout(() => {
              const error = new Error('Provider request aborted');
              error.name = 'AbortError';
              reject(error);
            }, 250);
          };
          if (options.signal.aborted) abort();
          else options.signal.addEventListener('abort', abort, { once: true });
        });
      }
    });
    const info = await abortServer.start();
    const abortUrl = info.url;
    t.after(async () => {
      await abortServer.close();
      await fs.rm(abortDir, { recursive: true, force: true });
    });

    const createRes = await fetch(abortUrl + '/session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + testToken
      },
      body: JSON.stringify({ mode: 'build', model: 'test-model' })
    });
    const { id: sessionId } = await createRes.json();

    const sseRes = await fetch(abortUrl + '/session/' + sessionId + '/events', {
      headers: { Authorization: 'Bearer ' + testToken }
    });
    assert.equal(sseRes.status, 200);

    const messageRes = await fetch(abortUrl + '/session/' + sessionId + '/message', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + testToken
      },
      body: JSON.stringify({ content: 'do a long task' })
    });
    assert.equal(messageRes.status, 202);
    await started;

    const abortRes = await fetch(abortUrl + '/session/' + sessionId + '/abort', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + testToken }
    });
    assert.equal(abortRes.status, 200);
    assert.equal((await abortRes.json()).aborted, true);

    const conflictingRes = await fetch(abortUrl + '/session/' + sessionId + '/message', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + testToken
      },
      body: JSON.stringify({ content: 'do not start concurrently' })
    });
    assert.equal(conflictingRes.status, 409);

    const reader = sseRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let eventName = '';
    let doneData = null;

    while (!doneData) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('event: ')) eventName = line.slice(7).trim();
        if (line.startsWith('data: ') && eventName === 'done') {
          doneData = JSON.parse(line.slice(6).trim());
          break;
        }
      }
    }
    await reader.cancel().catch(() => {});
    assert.equal(doneData?.reason, 'aborted');
  });

});
