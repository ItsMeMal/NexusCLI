import fs from 'node:fs';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { AnthropicProvider } from './anthropic.js';
import { GeminiProvider } from './gemini.js';

export { OpenAICompatibleProvider } from './openai-compatible.js';
export { AnthropicProvider } from './anthropic.js';
export { GeminiProvider } from './gemini.js';

/**
 * Factory function to create a provider instance based on config string "provider/model".
 * Supported providers: openai-compatible, anthropic, gemini
 * @param {string} configStr - String konfigurasi seperti "anthropic/claude-sonnet-4-5" atau "gpt-4o"
 * @param {Object} customConfig - Config tambahan (baseUrl, apiKey, dll)
 * @returns {Object} Instance kelas provider dengan method stream()
 */
export function createProvider(configStr, customConfig = {}) {
  // Parse configStr: bisa berupa "provider/model" atau hanya model name
  let providerName;
  let modelName;

  if (configStr && configStr.includes('/')) {
    [providerName, modelName] = configStr.split('/').map(s => s.trim());
  } else {
    // Default ke openai-compatible jika tidak ditentukan
    providerName = 'openai-compatible';
    modelName = configStr;
  }

  // Validasi provider name
  const providerMap = {
    'openai-compatible': OpenAICompatibleProvider,
    'anthropic': AnthropicProvider,
    'gemini': GeminiProvider
  };

  const ProviderClass = providerMap[providerName];
  if (!ProviderClass) {
    console.warn(`[Provider] Unknown provider: ${providerName}, falling back to openai-compatible`);
    return new (OpenAICompatibleProvider)(customConfig);
  }

  // Extract model from config jika provider memiliki model default sendiri
  const config = {
    ...customConfig,
    model: customConfig.model || modelName || ProviderClass.prototype.model || 'gpt-4o'
  };

  return new ProviderClass(config);
}

/**
 * Mendapatkan API key dari environment atau file kredensial (permission 600).
 * API key tidak pernah dicetak ke log atau output apa pun.
 * @param {string} envVar - Nama variabel environment (default: API_KEY)
 * @param {string} credentialFile - Path file kredensial (opsional)
 * @returns {string|undefined} API key atau undefined jika tidak ditemukan
 */
export function loadApiKey(envVar = 'API_KEY', credentialFile) {
  // 1. Coba environment variable pertama
  const envKey = process.env[envVar];
  if (envKey && envKey.trim()) {
    // Validasi bahwa ini kemungkinan adalah API key (bukan teks biasa)
    // Cek pola dasar: minimal 20 karakter untuk kebanyakan provider
    if (envKey.trim().length >= 20) {
      return envKey.trim();
    }
  }

  // 2. Coba file kredensial jika disediakan
  // Gunakan require sinkron (CommonJS compatible)
  if (credentialFile) {
    try {
      const content = fs.readFileSync(credentialFile, 'utf-8');
      const key = content.trim();
      // File kredensial harus memiliki permission 600, kita cek apakah key valid
      if (key && key.length >= 20) {
        return key;
      }
    } catch {
      // File tidak ada atau error baca, lanjutkan ke fallback
    }
  }

  // 3. Fallback ke env var alternatif
  const altEnv = process.env[envVar.replace('KEY', 'KEY2')] || process.env[envVar.toUpperCase()];
  if (altEnv && altEnv.length >= 20) {
    return altEnv;
  }

  return undefined;
}

/**
 * Return supported providers with their current environment configuration.
 * API keys are checked but never included in returned objects.
 */
export function getProviderCatalog(activeModel = '') {
  const hasKey = value => typeof value === 'string' && value.trim().length >= 20;
  const hasOpenAIKey = hasKey(process.env.API_KEY) || hasKey(process.env.OPENAI_API_KEY);
  const hasAnthropicKey = hasKey(process.env.ANTHROPIC_API_KEY);
  const hasGeminiKey = hasKey(process.env.GEMINI_API_KEY) || hasKey(process.env.GOOGLE_API_KEY);
  const activeParts = String(activeModel || '').split('/');
  const activeProvider = activeParts.length > 1 ? activeParts[0] : 'openai-compatible';
  const activeModelName = activeParts.length > 1 ? activeParts.slice(1).join('/') : activeModel;

  return [
    {
      name: 'openai-compatible',
      label: 'OpenAI-compatible',
      model: process.env.OPENAI_MODEL || process.env.MODEL || (activeProvider === 'openai-compatible' && activeModelName) || 'gpt-4o',
      configured: hasOpenAIKey,
      keyVariable: 'API_KEY or OPENAI_API_KEY',
      active: activeProvider === 'openai-compatible'
    },
    {
      name: 'anthropic',
      label: 'Anthropic',
      model: process.env.ANTHROPIC_MODEL || (activeProvider === 'anthropic' && activeModelName) || 'claude-3-5-sonnet-20241022',
      configured: hasAnthropicKey,
      keyVariable: 'ANTHROPIC_API_KEY',
      active: activeProvider === 'anthropic'
    },
    {
      name: 'gemini',
      label: 'Google Gemini',
      model: process.env.GEMINI_MODEL || (activeProvider === 'gemini' && activeModelName) || 'gemini-1.5-flash',
      configured: hasGeminiKey,
      keyVariable: 'GEMINI_API_KEY or GOOGLE_API_KEY',
      active: activeProvider === 'gemini'
    }
  ];
}

/**
 * Parse "provider/model" using the first slash so model IDs may contain slashes.
 * Provider-specific environment variables and credential files are respected.
 */
export function parseModelConfig(configStr) {
  const value = String(configStr || '').trim();
  const separatorIndex = value.indexOf('/');
  const provider = separatorIndex >= 0 ? value.slice(0, separatorIndex).trim() : 'openai-compatible';
  const model = separatorIndex >= 0 ? value.slice(separatorIndex + 1).trim() : value;
  const credentialFile = `/credentials/${provider.toLowerCase()}-key.txt`;

  let apiKey;
  let baseUrl;
  if (provider === 'anthropic') {
    apiKey = process.env.ANTHROPIC_API_KEY || loadApiKey('ANTHROPIC_API_KEY', credentialFile);
    baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  } else if (provider === 'gemini') {
    apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || loadApiKey('GEMINI_API_KEY', credentialFile);
    baseUrl = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
  } else if (provider === 'openai-compatible') {
    apiKey = process.env.API_KEY || process.env.OPENAI_API_KEY || loadApiKey('API_KEY', credentialFile);
    baseUrl = process.env.BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  } else {
    throw new Error(`Unsupported provider "${provider}". Supported providers: openai-compatible, anthropic, gemini.`);
  }

  return {
    provider,
    model,
    baseUrl: baseUrl.replace(/\\/+$/, ''),
    apiKey,
    credentialFile
  };
}
export default { createProvider, loadApiKey, parseModelConfig };