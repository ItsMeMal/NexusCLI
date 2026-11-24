import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const SUPPORTED_PROTOCOLS = new Set(['openai-compatible', 'anthropic', 'gemini']);

export const PROVIDER_PRESETS = [
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', protocol: 'openai-compatible', category: 'Popular' },
  { id: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com', protocol: 'anthropic', category: 'Popular' },
  { id: 'gemini', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com', protocol: 'gemini', category: 'Popular' },
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', protocol: 'openai-compatible', category: 'Popular' },
  { id: 'mallss-nexus-route', label: 'Mallss Nexus Route', baseUrl: 'https://ai-router.mallss-nexus.sbs/v1', protocol: 'openai-compatible', category: 'AI Gateways', authFlow: 'oauth2' },
  { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', protocol: 'openai-compatible', category: 'Popular' },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', protocol: 'openai-compatible', category: 'Popular' },
  { id: 'mistral', label: 'Mistral AI', baseUrl: 'https://api.mistral.ai/v1', protocol: 'openai-compatible', category: 'Services' },
  { id: 'cerebras', label: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1', protocol: 'openai-compatible', category: 'Services' },
  { id: 'together', label: 'Together AI', baseUrl: 'https://api.together.xyz/v1', protocol: 'openai-compatible', category: 'Services' },
  { id: 'fireworks', label: 'Fireworks AI', baseUrl: 'https://api.fireworks.ai/inference/v1', protocol: 'openai-compatible', category: 'Services' },
  { id: 'xai', label: 'xAI', baseUrl: 'https://api.x.ai/v1', protocol: 'openai-compatible', category: 'Services' },
  { id: 'deepinfra', label: 'DeepInfra', baseUrl: 'https://api.deepinfra.com/v1/openai', protocol: 'openai-compatible', category: 'Services' }
];

export function getProviderConfigDir() {
  return path.resolve(process.env.NEXUS_CONFIG_DIR || path.join(os.homedir(), '.nexuscli'));
}

function getRegistryPath() {
  return path.join(getProviderConfigDir(), 'providers.json');
}

function getCredentialsPath() {
  return path.join(getProviderConfigDir(), 'auth.json');
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readRegistry() {
  const parsed = readJson(getRegistryPath(), {});
  return Array.isArray(parsed.providers) ? parsed.providers : [];
}

function readCredentials() {
  const parsed = readJson(getCredentialsPath(), {});
  const credentials = parsed?.credentials;
  return credentials && typeof credentials === 'object' && !Array.isArray(credentials) ? credentials : {};
}

function writeSecureJson(filePath, value) {
  const dir = getProviderConfigDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
  const temp = filePath + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(temp, 0o600); } catch {}
  fs.renameSync(temp, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

function writeRegistry(providers) {
  writeSecureJson(getRegistryPath(), { version: 1, providers });
}

function writeCredentials(credentials) {
  writeSecureJson(getCredentialsPath(), { version: 1, credentials });
}

function cleanBaseUrl(value) {
  const url = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Provider URL must use HTTP or HTTPS.');
  }
  if (url.username || url.password) {
    throw new Error('Do not put credentials in the provider URL. Enter the API key in the secure connect prompt.');
  }
  return url.toString().replace(/\/+$/, '');
}

function normalizeProvider(provider) {
  if (!provider || typeof provider !== 'object') return null;
  const id = String(provider.id || '').trim().toLowerCase();
  if (!PROVIDER_ID.test(id)) return null;
  let baseUrl;
  try { baseUrl = cleanBaseUrl(provider.baseUrl || provider.base_url); } catch { return null; }
  const protocol = String(provider.protocol || 'openai-compatible');
  if (!SUPPORTED_PROTOCOLS.has(protocol)) return null;
  const apiKeyEnv = String(provider.apiKeyEnv || provider.api_key_env || '').trim();
  const defaultModel = String(provider.defaultModel || provider.default_model || '').trim();
  const models = Array.isArray(provider.models)
    ? provider.models.map(model => String(model).trim()).filter(Boolean)
    : [];
  return {
    id,
    label: String(provider.label || id).trim() || id,
    baseUrl,
    apiKeyEnv,
    protocol,
    defaultModel,
    models,
    source: provider.source || 'config',
    authFlow: provider.authFlow === 'oauth2' ? 'oauth2' : 'api-key'
  };
}

function envProviders() {
  const providers = [];
  const ids = new Set();

  for (const [key, baseUrl] of Object.entries(process.env)) {
    const match = key.match(/^NEXUS_PROVIDER_([A-Z0-9_]+)_BASE_URL$/);
    if (!match || !baseUrl) continue;
    const prefix = match[1];
    const id = prefix.toLowerCase().replace(/_/g, '-');
    const provider = normalizeProvider({
      id,
      label: process.env['NEXUS_PROVIDER_' + prefix + '_LABEL'] || id,
      baseUrl,
      apiKeyEnv: 'NEXUS_PROVIDER_' + prefix + '_API_KEY',
      defaultModel: process.env['NEXUS_PROVIDER_' + prefix + '_MODEL'] || '',
      source: 'environment'
    });
    if (provider && !ids.has(id)) {
      providers.push(provider);
      ids.add(id);
    }
  }

  const legacyBaseUrl = process.env.BASE_URL || process.env.OPENAI_BASE_URL;
  const legacyKeyEnv = process.env.API_KEY ? 'API_KEY' : (process.env.OPENAI_API_KEY ? 'OPENAI_API_KEY' : '');
  if (legacyBaseUrl && !ids.has('default-gateway')) {
    const provider = normalizeProvider({
      id: 'default-gateway',
      label: process.env.NEXUS_PROVIDER_LABEL || 'Default Gateway',
      baseUrl: legacyBaseUrl,
      apiKeyEnv: legacyKeyEnv || 'API_KEY',
      defaultModel: process.env.MODEL || process.env.OPENAI_MODEL || '',
      source: 'environment'
    });
    if (provider) {
      providers.push(provider);
      ids.add(provider.id);
    }
  } else if (process.env.OPENAI_API_KEY && !ids.has('openai')) {
    const provider = normalizeProvider({
      id: 'openai',
      label: 'OpenAI',
      baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      apiKeyEnv: 'OPENAI_API_KEY',
      defaultModel: process.env.OPENAI_MODEL || '',
      source: 'environment'
    });
    if (provider) {
      providers.push(provider);
      ids.add(provider.id);
    }
  }

  if (process.env.ANTHROPIC_API_KEY && !ids.has('anthropic')) {
    providers.push({
      id: 'anthropic',
      label: 'Anthropic',
      baseUrl: (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, ''),
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      protocol: 'anthropic',
      defaultModel: process.env.ANTHROPIC_MODEL || '',
      models: [],
      source: 'environment'
    });
    ids.add('anthropic');
  }

  const geminiKeyEnv = process.env.GEMINI_API_KEY ? 'GEMINI_API_KEY' : (process.env.GOOGLE_API_KEY ? 'GOOGLE_API_KEY' : '');
  if (geminiKeyEnv && !ids.has('gemini')) {
    providers.push({
      id: 'gemini',
      label: 'Google Gemini',
      baseUrl: (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/+$/, ''),
      apiKeyEnv: geminiKeyEnv,
      protocol: 'gemini',
      defaultModel: process.env.GEMINI_MODEL || '',
      models: [],
      source: 'environment'
    });
    ids.add('gemini');
  }

  return providers;
}

function mergeProviders() {
  const merged = new Map();
  for (const raw of readRegistry()) {
    const provider = normalizeProvider(raw);
    if (provider) merged.set(provider.id, provider);
  }
  for (const provider of envProviders()) {
    const existing = merged.get(provider.id);
    merged.set(provider.id, existing
      ? { ...existing, ...provider, source: 'environment' }
      : provider);
  }
  return Array.from(merged.values()).sort((a, b) => a.label.localeCompare(b.label));
}

function resolveCredential(provider) {
  const credentials = readCredentials();
  const localValue = credentials[provider?.id];
  if (typeof localValue === 'string' && localValue.trim()) return localValue.trim();
  if (localValue && typeof localValue === 'object' && typeof localValue.accessToken === 'string' && localValue.accessToken.trim()) return localValue.accessToken.trim();
  if (provider?.apiKeyEnv && process.env[provider.apiKeyEnv]?.trim()) {
    return process.env[provider.apiKeyEnv].trim();
  }
  return '';
}

export function getProviderConfig(id) {
  const provider = mergeProviders().find(item => item.id === String(id || '').toLowerCase());
  if (!provider) return null;
  return { ...provider, apiKey: resolveCredential(provider) };
}

export function getProviderCatalog(activeModel = '') {
  const activeProviderId = String(activeModel || '').includes('/')
    ? String(activeModel).split('/')[0]
    : (process.env.NEXUS_DEFAULT_PROVIDER || '');
  return mergeProviders().map(provider => {
    const configured = Boolean(resolveCredential(provider));
    return {
      ...provider,
      configured,
      connected: configured,
      keyVariable: provider.authFlow === 'oauth2' ? 'browser account' : (provider.apiKeyEnv || 'local credential'),
      active: provider.id === activeProviderId
    };
  });
}

export function getProviderPickerCatalog(activeModel = '') {
  const activeProviderId = String(activeModel || '').includes('/')
    ? String(activeModel).split('/')[0]
    : (process.env.NEXUS_DEFAULT_PROVIDER || '');
  const configured = new Map(mergeProviders().map(provider => [provider.id, provider]));
  const presets = PROVIDER_PRESETS.map(preset => ({ ...preset }));
  const known = new Set(presets.map(provider => provider.id));
  const extras = Array.from(configured.values())
    .filter(provider => !known.has(provider.id))
    .map(provider => ({
      ...provider,
      category: provider.source === 'environment' ? 'Environment' : 'Custom'
    }));
  return [...presets, ...extras].map(provider => {
    const saved = configured.get(provider.id);
    const merged = saved ? { ...provider, ...saved, category: provider.category || 'Custom' } : provider;
    const key = saved ? resolveCredential(saved) : '';
    return {
      ...merged,
      configured: Boolean(key),
      connected: Boolean(key),
      keyVariable: merged.authFlow === 'oauth2' ? 'browser account' : (merged.apiKeyEnv || 'local credential'),
      active: merged.id === activeProviderId,
      detail: merged.baseUrl
    };
  }).sort((a, b) => {
    const order = { Popular: 0, Services: 1, Custom: 2, Environment: 3 };
    return (order[a.category] ?? 9) - (order[b.category] ?? 9) || a.label.localeCompare(b.label);
  });
}

function upsertProvider(metadata) {
  const provider = normalizeProvider(metadata);
  if (!provider) throw new Error('Invalid provider configuration.');
  const providers = readRegistry().filter(item => String(item.id || '').toLowerCase() !== provider.id);
  providers.push({
    id: provider.id,
    label: provider.label,
    baseUrl: provider.baseUrl,
    apiKeyEnv: provider.apiKeyEnv,
    protocol: provider.protocol,
    defaultModel: provider.defaultModel,
    models: provider.models,
    authFlow: provider.authFlow
  });
  writeRegistry(providers);
  return provider;
}

export function addProvider({ id, label, baseUrl, apiKeyEnv = '', defaultModel = '', models = [], protocol = 'openai-compatible', authFlow = 'api-key' } = {}) {
  const normalizedId = String(id || '').trim().toLowerCase();
  if (!PROVIDER_ID.test(normalizedId)) {
    throw new Error('Provider ID must use lowercase letters, numbers, hyphens, or underscores.');
  }
  const envName = String(apiKeyEnv || '').trim();
  if (envName && !/^[A-Z_][A-Z0-9_]*$/.test(envName)) {
    throw new Error('API key reference must be a valid environment variable name, e.g. OPENROUTER_API_KEY.');
  }
  if (!SUPPORTED_PROTOCOLS.has(protocol)) {
    throw new Error('Unsupported provider protocol: ' + protocol);
  }
  if (!['api-key', 'oauth2'].includes(authFlow)) throw new Error('Unsupported provider authentication flow: ' + authFlow);
  upsertProvider({
    id: normalizedId,
    label: String(label || normalizedId).trim() || normalizedId,
    baseUrl,
    apiKeyEnv: envName,
    protocol,
    defaultModel: String(defaultModel || '').trim(),
    models: Array.isArray(models) ? models : [],
    authFlow
  });
  return getProviderConfig(normalizedId);
}

export function addLocalProvider({ id, label, baseUrl, apiKey, defaultModel = '', protocol = 'openai-compatible' } = {}) {
  const normalizedId = String(id || '').trim().toLowerCase();
  if (!PROVIDER_ID.test(normalizedId)) {
    throw new Error('Provider ID must use lowercase letters, numbers, hyphens, or underscores.');
  }
  if (!String(apiKey || '').trim()) throw new Error('API key is required.');
  addProvider({ id: normalizedId, label, baseUrl, apiKeyEnv: '', defaultModel, protocol });
  connectProvider(normalizedId, apiKey);
  return getProviderConfig(normalizedId);
}

export function connectProvider(providerId, apiKey) {
  const id = String(providerId || '').trim().toLowerCase();
  const secret = String(apiKey || '').trim();
  if (!secret) throw new Error('API key is required.');
  let provider = getProviderConfig(id);
  if (!provider) {
    const preset = PROVIDER_PRESETS.find(item => item.id === id);
    if (!preset) throw new Error('Unknown provider: ' + id);
    addProvider({ ...preset, apiKeyEnv: '' });
    provider = getProviderConfig(id);
  }
  const credentials = readCredentials();
  credentials[id] = secret;
  writeCredentials(credentials);
  return getProviderConfig(id);
}

export function saveOAuthCredential(providerId, tokenBundle) {
  const id = String(providerId || '').trim().toLowerCase();
  if (!PROVIDER_ID.test(id)) throw new Error('Invalid provider ID for OAuth credentials.');
  const accessToken = String(tokenBundle?.access_token || tokenBundle?.accessToken || '').trim();
  const refreshToken = String(tokenBundle?.refresh_token || tokenBundle?.refreshToken || '').trim();
  const expiresAt = Number(tokenBundle?.expires_at || tokenBundle?.expiresAt ||
    (Date.now() + Math.max(1, Number(tokenBundle?.expires_in || 0)) * 1000));
  if (!accessToken || !refreshToken || !Number.isFinite(expiresAt)) {
    throw new Error('OAuth response did not contain valid access and refresh tokens.');
  }
  const credentials = readCredentials();
  credentials[id] = {
    type: 'oauth2',
    accessToken,
    refreshToken,
    expiresAt,
    user: tokenBundle.user && typeof tokenBundle.user === 'object' ? tokenBundle.user : null
  };
  writeCredentials(credentials);
  return { accessToken, refreshToken, expiresAt, user: credentials[id].user };
}

export function getOAuthCredential(providerId) {
  const id = String(providerId || '').trim().toLowerCase();
  const value = readCredentials()[id];
  if (!value || typeof value !== 'object' || value.type !== 'oauth2') return null;
  return {
    accessToken: String(value.accessToken || ''),
    refreshToken: String(value.refreshToken || ''),
    expiresAt: Number(value.expiresAt || 0),
    user: value.user && typeof value.user === 'object' ? value.user : null
  };
}

export function clearOAuthCredential(providerId) {
  const id = String(providerId || '').trim().toLowerCase();
  const credentials = readCredentials();
  if (!credentials[id] || typeof credentials[id] !== 'object' || credentials[id].type !== 'oauth2') return false;
  delete credentials[id];
  writeCredentials(credentials);
  return true;
}

export function disconnectProvider(providerId) {
  const id = String(providerId || '').trim().toLowerCase();
  const credentials = readCredentials();
  if (!Object.hasOwn(credentials, id)) return false;
  delete credentials[id];
  writeCredentials(credentials);
  return true;
}

export function removeProvider(id) {
  const normalizedId = String(id || '').trim().toLowerCase();
  const stored = readRegistry();
  const next = stored.filter(provider => String(provider.id || '').toLowerCase() !== normalizedId);
  const removed = next.length !== stored.length;
  const disconnected = disconnectProvider(normalizedId);
  if (removed) writeRegistry(next);
  return removed || disconnected;
}

export function getDefaultModelSelection() {
  const envModel = String(process.env.MODEL || process.env.OPENAI_MODEL || '').trim();
  if (envModel.includes('/')) return envModel;
  const providers = mergeProviders();
  const preferred = providers.find(provider => provider.id === process.env.NEXUS_DEFAULT_PROVIDER);
  const provider = preferred || (providers.length === 1 ? providers[0] : null);
  const model = provider?.defaultModel || envModel;
  return provider && model ? provider.id + '/' + model : '';
}

export async function listProviderModels(providerId) {
  const provider = getProviderConfig(providerId);
  if (!provider) throw new Error('Provider not found: ' + providerId);
  let credential = provider.apiKey;
  if (provider.authFlow === 'oauth2') {
    const { getOAuthAccessToken } = await import('./oauth.js');
    credential = await getOAuthAccessToken(providerId);
  }
  if (!credential) throw new Error('Connect ' + provider.label + ' first with /provider.');
  const baseUrl = provider.baseUrl.replace(/\/+$/, '');
  let response;
  if (provider.protocol === 'anthropic') {
    response = await fetch(baseUrl.replace(/\/v1$/, '') + '/v1/models', {
      headers: { 'x-api-key': credential, 'anthropic-version': '2023-06-01', Accept: 'application/json' }
    });
  } else if (provider.protocol === 'gemini') {
    response = await fetch(baseUrl.replace(/\/v1beta$/, '') + '/v1beta/models?key=' + encodeURIComponent(credential), {
      headers: { Accept: 'application/json' }
    });
  } else {
    response = await fetch(baseUrl + '/models', {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + credential, Accept: 'application/json' }
    });
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(provider.label + ' returned HTTP ' + response.status + (detail ? ': ' + detail.slice(0, 240) : ''));
  }
  const payload = await response.json();
  let rawModels = Array.isArray(payload?.data) ? payload.data
    : (Array.isArray(payload?.models) ? payload.models : []);
  if (provider.protocol === 'gemini') {
    rawModels = rawModels.filter(item =>
      !Array.isArray(item?.supportedGenerationMethods) ||
      item.supportedGenerationMethods.includes('generateContent')
    );
  }
  const models = rawModels.map(item => {
    const value = typeof item === 'string' ? item : (item?.id || item?.name);
    return typeof value === 'string' ? value.replace(/^models\//, '') : value;
  }).filter(value => typeof value === 'string' && value.trim());
  const uniqueModels = [...new Set(models)];
  const finalModels = uniqueModels.length ? uniqueModels : provider.models;
  return finalModels.map(id => ({
    id: provider.id + '/' + id,
    model: id,
    providerId: provider.id,
    providerLabel: provider.label
  }));
}

export async function listAllModels(providerId = null) {
  const providers = mergeProviders().filter(provider => !providerId || provider.id === providerId);
  const connected = providers.filter(provider => Boolean(resolveCredential(provider)));
  const settled = await Promise.all(connected.map(async provider => {
    try {
      const models = await listProviderModels(provider.id);
      return { models, error: null, providerId: provider.id };
    } catch (error) {
      return { models: [], error: error.message, providerId: provider.id };
    }
  }));
  return {
    models: settled.flatMap(result => result.models).sort((a, b) =>
      a.providerLabel.localeCompare(b.providerLabel) || a.model.localeCompare(b.model)
    ),
    errors: settled.filter(result => result.error).map(result => ({ providerId: result.providerId, error: result.error }))
  };
}
