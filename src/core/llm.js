export function getLLMConfig(customConfig = {}) {
  const baseUrl = customConfig.baseUrl ||
    process.env.BASE_URL ||
    process.env.OPENAI_BASE_URL ||
    'https://api.openai.com/v1';

  const apiKey = customConfig.apiKey ||
    process.env.API_KEY ||
    process.env.OPENAI_API_KEY ||
    '';

  const model = customConfig.model ||
    process.env.MODEL ||
    process.env.OPENAI_MODEL ||
    'gpt-4o';

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    model
  };
}

/**
 * Parse model config string "provider/model" and load API key securely.
 * @param {string} modelStr - Model string like "gpt-4o" or "anthropic/claude-3-opus"
 * @returns {Object} { providerInstance, apiKey, config }
 */
async function initializeProvider(modelStr = 'gpt-4o', customOptions = {}) {
  const { createProvider, loadApiKey, parseModelConfig } = await import('./providers/index.js');
  const parsed = parseModelConfig(modelStr);
  const apiKey = parsed.apiKey || loadApiKey('API_KEY', parsed.credentialFile);

  if (!apiKey) {
    const keyHint = parsed.provider === 'anthropic'
      ? 'ANTHROPIC_API_KEY'
      : parsed.provider === 'gemini'
        ? 'GEMINI_API_KEY or GOOGLE_API_KEY'
        : 'API_KEY or OPENAI_API_KEY';
    throw new Error(`Missing API key for provider "${parsed.provider}". Set ${keyHint}.`);
  }

  const provider = createProvider(parsed.provider, {
    ...customOptions,
    baseUrl: parsed.baseUrl,
    apiKey,
    model: parsed.model
  });
  return { provider, apiKey, config: parsed };
}

/**
 * Stream chat completions menggunakan provider abstraction.
 * Mengembalikan async iterator yang emisikan event yang sudah dinormalisasi.
 * @param {Array} messages - Array pesan chat
 * @param {Array} tools - Daftar tool definitions (optional)
 * @param {Object} options - opsi { onToken, onToolStart, onToolResult, onDone, onError, model }
 * @returns {Promise<Object>} Pesan final dari LLM dengan format yang konsisten
 */
export async function providerChat(messages, tools = [], options = {}) {
  const { provider, config } = await initializeProvider(options.model || 'gpt-4o', options);

  const onToken = options.onToken || (() => {});
  const onToolStart = options.onToolStart || (() => {});
  const onToolResult = options.onToolResult || (() => {});
  const onDone = options.onDone || (() => {});
  const onError = options.onError || ((err) => { throw err; });
  const toolCalls = new Map();

  let finalContent = '';
  let finalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  const events = provider.stream(messages, tools, {
    model: config.model,
    temperature: options.temperature,
    signal: options.signal,
    onToken: (content, normalizedUsage) => {
      if (typeof content === 'string') {
        finalContent += content;
        onToken(content);
      }

      if (normalizedUsage && typeof normalizedUsage === 'object') {
        finalUsage = {
          prompt_tokens: normalizedUsage.prompt_tokens ?? finalUsage.prompt_tokens,
          completion_tokens: normalizedUsage.completion_tokens ?? finalUsage.completion_tokens,
          total_tokens: normalizedUsage.total_tokens ?? finalUsage.total_tokens
        };
      }
    },
    onToolStart: (toolInfo) => {
      const key = Number.isInteger(toolInfo.index)
        ? `index:${toolInfo.index}`
        : (toolInfo.id || `name:${toolInfo.name || 'tool'}`);
      const existing = toolCalls.get(key) || {
        id: toolInfo.id || key,
        name: '',
        arguments: ''
      };

      if (toolInfo.id) existing.id = toolInfo.id;
      if (toolInfo.name && toolInfo.name !== 'unknown') existing.name = toolInfo.name;
      if (typeof toolInfo.args === 'string') {
        existing.arguments += toolInfo.args;
      } else if (toolInfo.args && typeof toolInfo.args === 'object') {
        existing.arguments = JSON.stringify(toolInfo.args);
      }

      toolCalls.set(key, existing);
      onToolStart(toolInfo);
    },
    onToolResult,
    onDone: (result) => {
      if (result?.usage && typeof result.usage === 'object') {
        finalUsage = {
          prompt_tokens: result.usage.prompt_tokens ?? finalUsage.prompt_tokens,
          completion_tokens: result.usage.completion_tokens ?? finalUsage.completion_tokens,
          total_tokens: result.usage.total_tokens ?? finalUsage.total_tokens
        };
      }
      onDone(result);
    },
    onError
  });

  try {
    for await (const event of events) {
      // Provider implementations stream through callbacks and complete this iterator.
    }
  } catch (err) {
    onError(err);
    throw err;
  }

  const normalizedToolCalls = Array.from(toolCalls.values())
    .filter(call => call.name)
    .map(call => ({
      id: call.id,
      type: 'function',
      function: {
        name: call.name,
        arguments: call.arguments || '{}'
      }
    }));

  return {
    role: 'assistant',
    content: finalContent || null,
    ...(normalizedToolCalls.length ? { tool_calls: normalizedToolCalls } : {}),
    usage: finalUsage
  };
}

/**
 * Main chat function - now uses provider abstraction behind the scenes.
 * Ke backwards compatibility: signature sama dengan chat() asli.
 * @param {Array} messages - Array pesan
 * @param {Array} tools - Tool definitions
 * @param {Object} options - { model, temperature, onToken, onToolStart, onToolResult, onDone, onError, stream }
 * @returns {Promise<Object>} Message dari LLM
 */
export async function chat(messages, tools = [], options = {}) {
  const config = getLLMConfig(options);

  // An explicit provider/model selection must use that provider, not silently fall back.
  if (options.model && options.model.includes('/')) {
    return await providerChat(messages, tools, options);
  }

  // Default OpenAI-compatible direct API
  if (!config.apiKey && !options.skipApiKeyCheck) {
    throw new Error('LLM API key is missing. Set API_KEY or OPENAI_API_KEY in environment.');
  }

  const stream = options.stream !== false;

  const payload = {
    model: config.model,
    messages,
    stream
  };

  if (stream) {
    payload.stream_options = { include_usage: true };
  }

  if (Array.isArray(tools) && tools.length > 0) {
    payload.tools = tools;
    payload.tool_choice = 'auto';
  }

  let response;
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`
      },
      body: JSON.stringify(payload),
      signal: options.signal
    });
  } catch (networkErr) {
    throw new Error(`LLM network connection failed: ${networkErr.message}`);
  }

  if (!response.ok) {
    let errorDetail = '';
    try {
      const errorJson = await response.json();
      errorDetail = errorJson?.error?.message || JSON.stringify(errorJson);
    } catch {
      try {
        errorDetail = await response.text();
      } catch {
        errorDetail = response.statusText;
      }
    }
    throw new Error(`LLM HTTP ${response.status} (${response.statusText}): ${errorDetail || 'Unknown API error'}`);
  }

  if (stream && response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    return await processSSEChunks(reader, { onToken: options.onToken });
  }

  let responseData;
  try {
    responseData = await response.json();
  } catch (err) {
    throw new Error(`Failed to parse LLM response as JSON: ${err.message}`);
  }

  const choice = responseData?.choices?.[0];
  if (!choice || !choice.message) {
    throw new Error('LLM response missing message choices.');
  }

  const message = choice.message;
  message.usage = responseData.usage || {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0
  };

  return message;
}

/**
 * Mendapatkan daftar provider yang tersedia dan konfigurasi mereka.
 * @returns {Array} Daftar konfigurasi provider
 */
export function listProviders() {
  return [
    { name: 'openai-compatible', config: 'MODEL' },
    { name: 'anthropic', config: 'ANTHROPIC_API_KEY / ANTHROPIC_MODEL' },
    { name: 'gemini', config: 'GEMINI_API_KEY / GEMINI_MODEL' }
  ];
}

export async function processSSEChunks(reader, { onToken } = {}) {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let content = '';
  const toolCallsMap = [];
  let usage = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) continue; // Ignore SSE comments/pings
      if (!trimmed.startsWith('data: ')) continue;

      const payload = trimmed.slice(6).trim();
      if (payload === '[DONE]') continue;

      try {
        const json = JSON.parse(payload);

        if (json.usage) {
          usage = json.usage;
        }

        const choice = json.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta;
        if (!delta) continue;

        if (delta.content) {
          content += delta.content;
          onToken?.(delta.content);
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCallsMap[idx]) {
              toolCallsMap[idx] = {
                id: '',
                type: 'function',
                function: {
                  name: '',
                  arguments: ''
                }
              };
            }
            if (tc.id) toolCallsMap[idx].id = tc.id;
            if (tc.function?.name) toolCallsMap[idx].function.name += tc.function.name;
            if (tc.function?.arguments) toolCallsMap[idx].function.arguments += tc.function.arguments;
          }
        }
      } catch {
        // Skip unparseable delta
      }
    }
  }

  const tool_calls = toolCallsMap.filter(Boolean);

  if (!usage) {
    // Approximate token usage if provider stream omits usage chunk
    const estPrompt = 50;
    const estCompletion = Math.max(1, Math.ceil(content.length / 4));
    usage = {
      prompt_tokens: estPrompt,
      completion_tokens: estCompletion,
      total_tokens: estPrompt + estCompletion
    };
  }

  const message = {
    role: 'assistant',
    content: content || null,
    ...(tool_calls.length > 0 ? { tool_calls } : {}),
    usage
  };

  return message;
}