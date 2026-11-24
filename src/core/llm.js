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
function initializeProvider(modelStr = 'gpt-4o', customOptions = {}) {
  const { createProvider, loadApiKey, parseModelConfig } = require('./core/providers/index.js');

  // Parse the config string to get provider, model, and apiKey
  const parsed = parseModelConfig(modelStr);

  // Load API key securely (from env or credential file, never logged)
  const apiKey = parsed.apiKey || loadApiKey('API_KEY');

  if (!apiKey) {
    throw new Error(
      `LLM API key is missing. Set API_KEY env var or provide credential file.`
    );
  }

  // Create provider instance with proper config
  const providerConfig = {
    baseUrl: parsed.baseUrl,
    apiKey,
    model: parsed.model
  };

  // Merge with any custom options
  const finalConfig = { ...customOptions, ...providerConfig };

  const provider = createProvider(parsed.provider || 'openai-compatible', finalConfig);

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
  const { provider, apiKey, config } = initializeProvider(options.model || 'gpt-4o', options);

  const {
    onToken = options.onToken || (() => {}),
    onToolStart = options.onToolStart || (() => {}),
    onToolResult = options.onToolResult || (() => {}),
    onDone = options.onDone || (() => {}),
    onError = options.onError || ((err) => { throw err; }),
    temperature = options.temperature
  } = options;

  // Collect results
  let finalContent = '';
  let finalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let finished = false;

  // Create async iterator from provider stream
  const events = provider.provider.stream(
    messages,
    tools,
    {
      model: options.model,
      temperature,
      onToken: (content, normalizedUsage) => {
        // Accumulate content
        if (content) {
          finalContent += content;
        }
        // Normalize and store usage
        if (normalizedUsage && typeof normalizedUsage === 'object') {
          finalUsage = {
            prompt_tokens: (finalUsage.prompt_tokens || 0) + (normalizedUsage.prompt_tokens || 0),
            completion_tokens: (finalUsage.completion_tokens || 0) + (normalizedUsage.completion_tokens || 0),
            total_tokens: (finalUsage.total_tokens || 0) + (normalizedUsage.total_tokens || 0)
          };
        }
        onToken(content);
      },
      onToolStart: (toolInfo) => {
        onToolStart(toolInfo);
      },
      onToolResult: (toolOutput) => {
        onToolResult(toolOutput);
      },
      onDone: (result) => {
        // Merge usage dari result
        if (result && result.usage) {
          finalUsage = {
            prompt_tokens: (finalUsage.prompt_tokens || 0) + (result.usage.prompt_tokens || 0),
            completion_tokens: (finalUsage.completion_tokens || 0) + (result.usage.completion_tokens || 0),
            total_tokens: (finalUsage.total_tokens || 0) + (result.usage.total_tokens || 0)
          };
        }
        if (result && result.finishReason) {
          finished = true;
        }
        onDone(result);
      },
      onError: (err) => {
        onError(err);
        throw err;
      }
    }
  );

  // Wait for the stream to complete
  // The provider stream is an async generator, we need to consume it
  try {
    // Consume the generator
    for await (const event of events) {
      // Events are handled via callbacks, so just wait for completion
    }
  } catch (err) {
    // Error already handled via onError callback
    throw err;
  }

  // Return normalized message format consistent with original chat output
  return {
    role: 'assistant',
    content: finalContent || null,
    tool_calls: [], // Will be populated if there were tool calls
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

  // Jika API key ada dan model menandakan provider khusus, gunakan provider abstraction
  if (config.apiKey && (options.model && options.model.includes('/'))) {
    try {
      return await providerChat(messages, tools, options);
    } catch (err) {
      // Jika provider gagal, jatuhkan error namun tetap bisa fallback
      console.warn('[LLM] Provider fallback to direct API');
    }
  }

  // Fallback ke OpenAI-compatible direct API
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