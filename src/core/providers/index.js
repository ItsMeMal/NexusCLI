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
    model: modelName || ProviderClass.prototype.model || 'gpt-4o'
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
      const fs = require('node:fs');
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
 * Mendapatkan konfigurasi model lengkap dari config string.
 * @param {string} configStr - "provider/model" atau hanya model
 * @returns {Object} { provider, model, baseUrl, apiKey }
 */
export function parseModelConfig(configStr) {
  let provider;
  let model;
  let baseUrl;
  let credentialFile;

  if (configStr && configStr.includes('/')) {
    [provider, model] = configStr.split('/').map(s => s.trim());
    credentialFile = `/credentials/${provider.toLowerCase()}-key.txt`;
  } else {
    provider = 'openai-compatible';
    model = configStr;
    credentialFile = null;
  }

  const apiKey = loadApiKey('API_KEY', credentialFile);
  const resolvedBaseUrl = apiKey && !apiKey.startsWith('sk-') 
    ? `https://api.openai.com/v1` 
    : (process.env.BASE_URL || 'https://api.openai.com/v1');

  return {
    provider,
    model,
    baseUrl: resolvedBaseUrl,
    apiKey,
    credentialFile
  };
}

export default { createProvider, loadApiKey, parseModelConfig };