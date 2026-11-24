import fs from 'node:fs';
import path from 'node:path';

export function loadEnv(workingDir = process.cwd()) {
  const envPath = path.resolve(workingDir, '.env');
  if (fs.existsSync(envPath)) {
    try {
      const content = fs.readFileSync(envPath, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
          const key = trimmed.slice(0, eqIdx).trim();
          let val = trimmed.slice(eqIdx + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
      }
    } catch {
      // Ignore reading error
    }
  }
}

export function getConfig(workingDir = process.cwd()) {
  loadEnv(workingDir);
  return {
    baseUrl: process.env.BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    apiKey: process.env.API_KEY || process.env.OPENAI_API_KEY || '',
    model: process.env.MODEL || process.env.OPENAI_MODEL || 'Elaina-Free',
    serverHost: process.env.NEXUS_HOST || '127.0.0.1',
    serverPort: Number(process.env.NEXUS_PORT) || 4141,
    serverToken: process.env.NEXUS_SERVER_TOKEN || null
  };
}
