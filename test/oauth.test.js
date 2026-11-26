import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectMallssNexusRoute } from '../src/core/providers/oauth.js';

test('OAuth sign-in can be cancelled and closes its local callback listener', async () => {
  const controller = new AbortController();
  let redirectUri = '';
  let tokenExchangeCalls = 0;

  const pending = connectMallssNexusRoute({
    providerId: 'mallss-nexus-route-test',
    gatewayUrl: 'http://127.0.0.1:4100',
    signal: controller.signal,
    openBrowserImpl: async () => true,
    postTokenImpl: async () => {
      tokenExchangeCalls++;
      throw new Error('Token exchange should not run after cancellation');
    },
    onStatus: ({ redirectUri: callbackUrl, authorizeUrl, opened }) => {
      redirectUri = callbackUrl;
      assert.equal(opened, true);
      assert.match(authorizeUrl, /^http:\/\/127\.0\.0\.1:4100\/auth\/oauth\/authorize\?/);
      controller.abort();
    }
  });

  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(tokenExchangeCalls, 0);
  assert.ok(redirectUri.startsWith('http://127.0.0.1:'));

  await assert.rejects(
    fetch(redirectUri),
    error => error.cause?.code === 'ECONNREFUSED' || /fetch failed/i.test(error.message)
  );
});

test('OAuth sign-in respects an already-aborted signal before opening a browser', async () => {
  const controller = new AbortController();
  controller.abort();
  let opened = false;

  await assert.rejects(
    connectMallssNexusRoute({
      gatewayUrl: 'http://127.0.0.1:4100',
      signal: controller.signal,
      openBrowserImpl: async () => {
        opened = true;
        return true;
      }
    }),
    error => error.name === 'AbortError'
  );
  assert.equal(opened, false);
});
