import { createNexusServer } from '../src/server.js';
import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execAsync = promisify(exec);
const tmpBody = path.resolve('test/_e2e_body.json');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function curlJson(url, { method = 'GET', data = null } = {}) {
  let cmd = `curl.exe -s`;
  if (method === 'POST') {
    cmd += ` -X POST -H "Content-Type: application/json"`;
    if (data) {
      fs.writeFileSync(tmpBody, data);
      cmd += ` --data-binary @${tmpBody}`;
    }
  }
  cmd += ` "${url}"`;
  const { stdout } = await execAsync(cmd);
  return stdout;
}

async function testE2E() {
  const server = createNexusServer({ port: 4199, host: '127.0.0.1' });
  await server.start();
  const url = 'http://127.0.0.1:4199';
  let passed = 0;
  let failed = 0;

  function assert(condition, label) {
    if (condition) {
      console.log(`  ✔ ${label}`);
      passed++;
    } else {
      console.log(`  ✘ ${label}`);
      failed++;
    }
  }

  try {
    // ── Test 1: POST /session ──
    console.log('\n▶ Test 1: POST /session creates session');
    const createOut = await curlJson(`${url}/session`, {
      method: 'POST',
      data: JSON.stringify({ mode: 'build', model: 'Elaina-Free' })
    });
    const session = JSON.parse(createOut);
    assert(session.id && session.id.startsWith('ses_'), 'session ID created with ses_ prefix');
    assert(session.mode === 'build', 'mode is build');
    assert(session.model === 'Elaina-Free', 'model is Elaina-Free');

    // ── Test 2: GET /session lists ──
    console.log('\n▶ Test 2: GET /session lists sessions');
    const listOut = await curlJson(`${url}/session`);
    const list = JSON.parse(listOut);
    assert(Array.isArray(list), 'returns array');
    assert(list.some(s => s.id === session.id), 'created session appears in list');

    // ── Test 3: GET /session/:id ──
    console.log('\n▶ Test 3: GET /session/:id returns detail');
    const detailOut = await curlJson(`${url}/session/${session.id}`);
    const detail = JSON.parse(detailOut);
    assert(detail.id === session.id, 'returns correct session ID');
    assert(Array.isArray(detail.messages), 'has messages array');

    // ── Test 4: SSE + POST message end-to-end ──
    console.log('\n▶ Test 4: SSE stream receives events from message');

    // Start SSE listener in background
    const sseProc = spawn('curl.exe', ['-s', '-N', `${url}/session/${session.id}/events`]);
    let sseOutput = '';
    sseProc.stdout.on('data', (chunk) => { sseOutput += chunk.toString(); });

    await sleep(800); // Wait for SSE connection

    // Send message
    const msgOut = await curlJson(`${url}/session/${session.id}/message`, {
      method: 'POST',
      data: JSON.stringify({ content: 'Reply with exactly: hello world' })
    });
    const msgData = JSON.parse(msgOut);
    assert(msgData.accepted === true, 'POST /message returns accepted:true');
    assert(msgData.status === 'running', 'status is running');

    // Wait for SSE to receive events
    await sleep(15000);
    sseProc.kill();

    console.log('  [debug] raw SSE output length:', sseOutput.length);
    console.log('  [debug] raw SSE output (first 500 chars):', sseOutput.slice(0, 500));

    assert(sseOutput.includes('event: text.delta'), 'SSE received text.delta event');
    assert(sseOutput.includes('event: tool.start') || sseOutput.includes('event: done'), 'SSE received tool.start or done event');
    assert(sseOutput.includes('event: done'), 'SSE received done event');

    // ── Test 5: Permission endpoint returns 404 for unknown ID ──
    console.log('\n▶ Test 5: POST /permission/:id returns 404 for unknown');
    const permOut = await curlJson(`${url}/permission/nonexistent`, {
      method: 'POST',
      data: JSON.stringify({ allow: true })
    });
    const permData = JSON.parse(permOut);
    assert(permData.error && permData.error.includes('No pending'), 'returns 404-style error for unknown permission');

    // ── Test 6: Abort on idle session returns aborted:false ──
    console.log('\n▶ Test 6: POST /session/:id/abort on idle session');
    const abortOut = await curlJson(`${url}/session/${session.id}/abort`, { method: 'POST' });
    const abortData = JSON.parse(abortOut);
    assert(abortData.aborted === false, 'aborted:false for idle session');

    // ── Test 7: 404 for unknown routes ──
    console.log('\n▶ Test 7: Unknown route returns 404');
    const notFoundOut = await curlJson(`${url}/nonexistent`);
    const notFoundData = JSON.parse(notFoundOut);
    assert(notFoundData.error && notFoundData.error.includes('Route not found'), 'returns 404 for unknown route');

    // ── Test 8: Token auth rejection ──
    console.log('\n▶ Test 8: Auth token enforcement');
    const serverWithToken = createNexusServer({ port: 4200, host: '127.0.0.1', token: 'secret123' });
    await serverWithToken.start();
    try {
      const noAuth = await curlJson('http://127.0.0.1:4200/session');
      const noAuthData = JSON.parse(noAuth);
      assert(noAuthData.error && noAuthData.error.includes('Unauthorized'), 'missing token → 401');

      const withAuth = await execAsync(`curl.exe -s -H "Authorization: Bearer secret123" "http://127.0.0.1:4200/session"`);
      const withAuthData = JSON.parse(withAuth.stdout);
      assert(Array.isArray(withAuthData), 'valid token → 200 with data');
    } finally {
      await serverWithToken.close();
    }

  } finally {
    await server.close();
    fs.rmSync(tmpBody, { force: true });
  }

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`Hasil: ${passed} lulus, ${failed} gagal`);
  console.log(`${'═'.repeat(50)}`);
  process.exit(failed > 0 ? 1 : 0);
}

await testE2E();
