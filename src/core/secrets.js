const SECRET_PATTERNS = [
  // OpenAI / generic API keys
  { name: 'openai_key', regex: /sk-[A-Za-z0-9]{20,}/g },
  { name: 'api_key_assignment', regex: /(api[_-]?key|apikey|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9_\-]{16,}["']?/gi },
  // Bearer tokens
  { name: 'bearer', regex: /Bearer\s+[A-Za-z0-9_\-\.]{20,}/gi },
  // AWS
  { name: 'aws_access_key', regex: /AKIA[0-9A-Z]{16}/g },
  // GitHub tokens
  { name: 'github_token', regex: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  // .env style KEY=VALUE (generic long value)
  { name: 'env_secret', regex: /^[A-Z_]{4,}=.+$/gm }
];

export function containsSecret(text) {
  if (typeof text !== 'string') return false;
  for (const p of SECRET_PATTERNS) {
    p.regex.lastIndex = 0;
    if (p.regex.test(text)) return true;
  }
  return false;
}

export function redactSecrets(text) {
  if (typeof text !== 'string') return text;
  let result = text;
  for (const p of SECRET_PATTERNS) {
    p.regex.lastIndex = 0;
    result = result.replace(p.regex, (match) => {
      // Keep key name if assignment, redact value
      if (match.includes('=')) {
        const idx = match.indexOf('=');
        return match.slice(0, idx + 1) + '[REDACTED]';
      }
      if (match.toLowerCase().startsWith('bearer ')) {
        return 'Bearer [REDACTED]';
      }
      return '[REDACTED]';
    });
  }
  return result;
}

export function redactObject(obj) {
  if (typeof obj === 'string') return redactSecrets(obj);
  if (Array.isArray(obj)) return obj.map(redactObject);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (/key|secret|token|password|credential/i.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactObject(v);
      }
    }
    return out;
  }
  return obj;
}