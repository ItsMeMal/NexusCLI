import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export function getProviderConfigDir() {
  return path.resolve(process.env.NEXUS_CONFIG_DIR || path.join(os.homedir(), '.nexuscli'));
}

function getRegistryPath() {
  return path.join(getProviderConfigDir(), 'providers.json');
}

function readRegistry() {
  try {
    const parsed = JSON.parse(fs.readFileSync(getRegistryPath(), 'utf8'));
    return Array.isArray(parsed.providers) ? parsed.providers : [];
  } catch {
    return [];
  }
}

function writeRegistry(providers) {
  const dir = getProviderConfigDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = getRegistryPath();
  const temp = target + '.tmp';
  fs.writeFileSync(temp, JSON.stringify({ version: 1, providers }, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, target);
  try { fs.chmodSync(target, 0o600); } catch {}
}

function cleanBaseUrl(value) {
  const url = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Provider URL must use HTTP or HTTPS.');
  }
  if (url.username || url.password) {
    throw new Error('Do not put credentials in the provider URL. Use an API key environment variable.');
  }
  return url.toString().replace(/\/+$/, '');
}

function normalizeProvider(provider) {
  if (!provider || typeof provider !== 'object') return null;
  const id = String(provider.id || '').trim().toLowerCase();
  if (!PROVIDER_ID.test(id)) return null;
  let baseUrl;
  try { baseUrl = cleanBaseUrl(provider.baseUrl || provider.base_url); } catch { return null; }
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
    protocol: provider.protocol || 'openai-compatible',
    defaultModel,
    models,
    source: provider.source || 'config'
  };
}

function envProviders() {
  const providers = [];
  const ids = new Set();

  for (const [key, baseUrl] of Object.entries(process.env)) {
    const match = key.match(/^NEXUS_PROVIDER_([A-Z0-9_]+)_BASE_URL$/);
    if (!match || !baseUrl) continue;
    const id = match[1].toLowerCase().replace(/_/g, '-');
    const prefix = match[1];
    const apiKeyEnv = 'NEXUS_PROVIDER_' + prefix + '_API_KEY';
    const defaultModel = process.env['NEXUS_PROVIDER_' + prefix + '_MODEL'] || '';
    const provider = normalizeProvider({
      id,
      label: process.env['NEXUS_PROVIDER_' + prefix + '_LABEL'] || id,
      baseUrl,
      apiKeyEnv,
      defaultModel,
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

export function getProviderConfig(id) {
  const provider = mergeProviders().find(item => item.id === String(id || '').toLowerCase());
  if (!provider) return null;
  return { ...provider, apiKey: provider.apiKeyEnv ? (process.env[provider.apiKeyEnv] || '') : '' };
}

export function getProviderCatalog(activeModel = '') {
  const activeProviderId = String(activeModel || '').includes('/')
    ? String(activeModel).split('/')[0]
    : (process.env.NEXUS_DEFAULT_PROVIDER || '');
  return mergeProviders().map(provider => ({
    ...provider,
    configured: Boolean(provider.apiKeyEnv && process.env[provider.apiKeyEnv]),
    keyVariable: provider.apiKeyEnv || 'not set',
    active: provider.id === activeProviderId
  }));
}

export function addProvider({ id, label, baseUrl, apiKeyEnv, defaultModel = '', models = [] } = {}) {
  const normalizedId = String(id || '').trim().toLowerCase();
  if (!PROVIDER_ID.test(normalizedId)) {
    throw new Error('Provider ID must use lowercase letters, numbers, hyphens, or underscores.');
  }
  const normalizedUrl = cleanBaseUrl(baseUrl);
  const envName = String(apiKeyEnv || '').trim();
  if (!/^[A-Z_][A-Z0-9_]*$/.test(envName)) {
    throw new Error('API key reference must be a valid environment variable name, e.g. OPENROUTER_API_KEY.');
  }

  const providers = readRegistry().filter(provider => String(provider.id).toLowerCase() !== normalizedId);
  providers.push({
    id: normalizedId,
    label: String(label || normalizedId).trim() || normalizedId,
    baseUrl: normalizedUrl,
    apiKeyEnv: envName,
    protocol: 'openai-compatible',
    defaultModel: String(defaultModel || '').trim(),
    models: Array.isArray(models) ? models : []
  });
  writeRegistry(providers);
  return getProviderConfig(normalizedId);
}

export function removeProvider(id) {
  const normalizedId = String(id || '').trim().toLowerCase();
  const stored = readRegistry();
  const next = stored.filter(provider => String(provider.id || '').toLowerCase() !== normalizedId);
  if (next.length === stored.length) return false;
  writeRegistry(next);
  return true;
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
  if (!provider.apiKey) throw new Error('Missing ' + (provider.apiKeyEnv || 'API key') + ' for ' + provider.label + '.');
  if (provider.protocol !== 'openai-compatible') {
    const models = provider.models.length ? provider.models : (provider.defaultModel ? [provider.defaultModel] : []);
    return models.map(id => ({ id: provider.id + '/' + id, model: id, providerId: provider.id, providerLabel: provider.label }));
  }

  const response = await fetch(provider.baseUrl + '/models', {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + provider.apiKey, Accept: 'application/json' }
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(provider.label + ' returned HTTP ' + response.status + (detail ? ': ' + detail.slice(0, 240) : ''));
  }
  const payload = await response.json();
  const rawModels = Array.isArray(payload?.data) ? payload.data
    : (Array.isArray(payload?.models) ? payload.models : []);
  const models = rawModels.map(item => typeof item === 'string' ? item : (item?.id || item?.name))
    .filter(value => typeof value === 'string' && value.trim());
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
  const settled = await Promise.all(providers.map(async provider => {
    try {
      const models = await listProviderModels(provider.id);
      return { models, error: null, providerId: provider.id };
    } catch (error) {
      return { models: [], error: error.message, providerId: provider.id };
    }
  }));
  return {
    models: settled.flatMap(result => result.models),
    errors: settled.filter(result => result.error).map(result => ({ providerId: result.providerId, error: result.error }))
  };
}
