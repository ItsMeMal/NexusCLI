import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { clearOAuthCredential, getOAuthCredential, saveOAuthCredential } from './registry.js';

const CLIENT_ID = 'nexuscode';
const SCOPE = 'models:read inference';
const DEFAULT_GATEWAY = 'https://ai-router.mallss-nexus.sbs';
const CALLBACK_PATH = '/oauth/callback';

function getGatewayOrigin(value = process.env.NEXUS_ROUTE_BASE_URL || DEFAULT_GATEWAY) {
  const url = new URL(String(value).trim());
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Mallss Nexus Route URL must be a valid HTTP(S) origin.');
  }
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('Use HTTPS for Mallss Nexus Route outside localhost.');
  }
  return url.toString().replace(/\/+$/, '');
}

function openBrowser(url) {
  const commands = process.platform === 'win32'
    ? ['cmd', ['/d', '/s', '/c', 'start "" "' + url.replace(/"/g, '') + '"']]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const child = spawn(commands[0], commands[1], { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('spawn', () => { child.unref(); finish(true); });
      child.once('error', () => finish(false));
    } catch {
      finish(false);
    }
  });
}

function tokenError(payload, status) {
  return payload?.error?.message || payload?.message || 'OAuth request failed with HTTP ' + status + '.';
}

function normalizeTokenBundle(payload, previous = {}) {
  const accessToken = String(payload?.access_token || '').trim();
  const refreshToken = String(payload?.refresh_token || previous.refreshToken || '').trim();
  const expiresIn = Number(payload?.expires_in);
  if (!accessToken || !refreshToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error('Mallss Nexus Route returned an incomplete OAuth token response.');
  }
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: Date.now() + expiresIn * 1000,
    user: payload.user || previous.user || null
  };
}

async function postToken(gateway, fields) {
  const response = await fetch(gateway + '/auth/oauth/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json'
    },
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(20000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(tokenError(payload, response.status));
  return payload;
}

const refreshPromises = new Map();

async function refreshOAuthAccessToken(providerId) {
  const stored = getOAuthCredential(providerId);
  if (!stored?.accessToken || !stored.refreshToken) {
    throw new Error('Mallss Nexus Route is not connected. Run /connect and authorize NexusCode in your browser.');
  }
  if (stored.expiresAt > Date.now() + 60000) return stored.accessToken;

  const gateway = getGatewayOrigin();
  let payload;
  try {
    payload = await postToken(gateway, {
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: stored.refreshToken
    });
  } catch (error) {
    if (/expired|revoked|invalid_grant|invalid token/i.test(error.message || '')) clearOAuthCredential(providerId);
    throw new Error('Mallss Nexus Route session could not be refreshed. Run /connect to reconnect. ' + error.message);
  }
  const next = normalizeTokenBundle(payload, stored);
  saveOAuthCredential(providerId, next);
  return next.access_token;
}

export function getOAuthAccessToken(providerId = 'mallss-nexus-route') {
  const existing = refreshPromises.get(providerId);
  if (existing) return existing;
  const pending = refreshOAuthAccessToken(providerId).finally(() => refreshPromises.delete(providerId));
  refreshPromises.set(providerId, pending);
  return pending;
}

export async function connectMallssNexusRoute({
  providerId = 'mallss-nexus-route',
  gatewayUrl,
  signal,
  onStatus,
  openBrowserImpl = openBrowser,
  postTokenImpl = postToken,
  timeoutMs = 5 * 60 * 1000
} = {}) {
  const abortError = () => Object.assign(
    new Error('OAuth sign-in was cancelled.'),
    { name: 'AbortError', code: 'ABORT_ERR' }
  );
  if (signal?.aborted) throw abortError();

  const gateway = getGatewayOrigin(gatewayUrl);
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(32).toString('base64url');

  let callbackResolve;
  let callbackReject;
  let callbackSettled = false;
  const callbackResult = new Promise((resolve, reject) => {
    callbackResolve = resolve;
    callbackReject = reject;
  });

  const server = createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (request.method !== 'GET' || url.pathname !== CALLBACK_PATH) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    if (url.searchParams.get('state') !== state) {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.end('OAuth state mismatch. Return to NexusCode and try again.');
      return;
    }
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    response.writeHead(error || !code ? 400 : 200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer'
    });
    response.end(error || !code
      ? '<!doctype html><title>Connection cancelled</title><p>Authorization was not completed. Return to NexusCode.</p>'
      : '<!doctype html><title>Connected</title><p>Mallss Nexus Route connected. You can close this tab and return to NexusCode.</p>');
    if (callbackSettled) return;
    callbackSettled = true;
    if (error) callbackReject(new Error(url.searchParams.get('error_description') || 'Authorization was cancelled: ' + error));
    else if (!code) callbackReject(new Error('The OAuth callback did not include an authorization code.'));
    else callbackResolve(code);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not open a local OAuth callback listener.');
  }

  const redirectUri = 'http://127.0.0.1:' + address.port + CALLBACK_PATH;
  const authorizeUrl = new URL(gateway + '/auth/oauth/authorize');
  authorizeUrl.searchParams.set('client_id', CLIENT_ID);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('scope', SCOPE);

  const timeout = setTimeout(() => {
    if (callbackSettled) return;
    callbackSettled = true;
    callbackReject(new Error('OAuth sign-in timed out after ' + Math.round(timeoutMs / 1000) + ' seconds.'));
  }, timeoutMs);
  timeout.unref?.();

  const onAbort = () => {
    if (callbackSettled) return;
    callbackSettled = true;
    callbackReject(abortError());
  };

  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    if (signal?.aborted) throw abortError();

    const opened = await openBrowserImpl(authorizeUrl.toString());
    onStatus?.({
      opened,
      authorizeUrl: authorizeUrl.toString(),
      redirectUri
    });

    const code = await callbackResult;
    if (signal?.aborted) throw abortError();

    const payload = await postTokenImpl(gateway, {
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier
    });
    const bundle = normalizeTokenBundle(payload);
    saveOAuthCredential(providerId, bundle);
    return payload.user || bundle.user;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
    server.close();
    server.closeAllConnections?.();
  }
}

export async function revokeOAuthProvider(providerId = 'mallss-nexus-route') {
  const stored = getOAuthCredential(providerId);
  if (!stored?.refreshToken) {
    clearOAuthCredential(providerId);
    return false;
  }
  const gateway = getGatewayOrigin();
  try {
    const response = await fetch(gateway + '/auth/oauth/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        token: stored.refreshToken,
        token_type_hint: 'refresh_token'
      }),
      signal: AbortSignal.timeout(15000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(tokenError(payload, response.status));
    clearOAuthCredential(providerId);
    return true;
  } catch (error) {
    throw new Error('Could not revoke the remote OAuth session: ' + error.message);
  }
}