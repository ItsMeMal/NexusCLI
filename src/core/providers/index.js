import fs from 'node:fs';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { AnthropicProvider } from './anthropic.js';
import { GeminiProvider } from './gemini.js';
import {
  addProvider,
  getDefaultModelSelection,
  getProviderCatalog,
  getProviderConfig,
  listAllModels,
  listProviderModels,
  removeProvider
} from './registry.js';

export { OpenAICompatibleProvider } from './openai-compatible.js';
export { AnthropicProvider } from './anthropic.js';
export { GeminiProvider } from './gemini.js';
export {
  addProvider,
  getDefaultModelSelection,
  getProviderCatalog,
  getProviderConfig,
  listAllModels,
  listProviderModels,
  removeProvider
} from './registry.js';

export function createProvider(providerName, customConfig = {}) {
  const config = { ...customConfig };
  if (providerName === 'anthropic' || config.protocol === 'anthropic') {
    return new AnthropicProvider(config);
  }
  if (providerName === 'gemini' || config.protocol === 'gemini') {
    return new GeminiProvider(config);
  }
  return new OpenAICompatibleProvider(config);
}

export function loadApiKey(envVar = 'API_KEY', credentialFile) {
  const envKey = process.env[envVar];
  if (envKey && envKey.trim()) return envKey.trim();
  if (credentialFile) {
    try {
      const key = fs.readFileSync(credentialFile, 'utf8').trim();
      return key || undefined;
    } catch {}
  }
  return undefined;
}

export function parseModelConfig(configStr) {
  let value = String(configStr || '').trim();
  if (!value) value = getDefaultModelSelection();
  const separatorIndex = value.indexOf('/');
  let providerId;
  let model;
  if (separatorIndex >= 0) {
    providerId = value.slice(0, separatorIndex).trim().toLowerCase();
    model = value.slice(separatorIndex + 1).trim();
  } else {
    const providers = getProviderCatalog();
    const preferred = providers.find(provider => provider.id === process.env.NEXUS_DEFAULT_PROVIDER);
    const provider = preferred || (providers.length === 1 ? providers[0] : null);
    if (!provider) {
      throw new Error('No provider selected. Configure one with /provider add or set NEXUS_DEFAULT_PROVIDER.');
    }
    providerId = provider.id;
    model = value || provider.defaultModel;
  }

  if (!providerId || !model) {
    throw new Error('Model selection must use provider/model, for example openrouter/vendor/model-name.');
  }

  const config = getProviderConfig(providerId) || (
    providerId === 'openai-compatible' && (process.env.BASE_URL || process.env.OPENAI_BASE_URL)
      ? {
          id: 'openai-compatible',
          baseUrl: process.env.BASE_URL || process.env.OPENAI_BASE_URL,
          apiKey: process.env.API_KEY || process.env.OPENAI_API_KEY || '',
          protocol: 'openai-compatible',
          apiKeyEnv: process.env.API_KEY ? 'API_KEY' : 'OPENAI_API_KEY'
        }
      : null
  );
  if (!config) {
    throw new Error('Unknown provider "' + providerId + '". Use /provider to view configured providers.');
  }
  if (!config.apiKey) {
    throw new Error('Missing API key. Set ' + (config.apiKeyEnv || 'the provider API key') + ' in your local environment.');
  }

  return {
    provider: providerId,
    model,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    protocol: config.protocol || 'openai-compatible',
    apiKeyEnv: config.apiKeyEnv
  };
}

export default {
  createProvider,
  loadApiKey,
  parseModelConfig,
  addProvider,
  getProviderCatalog,
  listAllModels,
  removeProvider
};
