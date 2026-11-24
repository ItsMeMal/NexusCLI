import { createProvider, getProviderCatalog, parseModelConfig } from './providers/index.js';
import { getOAuthAccessToken } from './providers/oauth.js';

export function getLLMConfig(customConfig = {}) {
  return {
    model: customConfig.model || process.env.MODEL || '',
    baseUrl: '',
    apiKey: ''
  };
}

async function initializeProvider(modelStr = '', customOptions = {}) {
  const parsed = parseModelConfig(modelStr);
  const apiKey = parsed.authFlow === 'oauth2' ? await getOAuthAccessToken(parsed.provider) : parsed.apiKey;
  const provider = createProvider(parsed.provider, {
    ...customOptions,
    protocol: parsed.protocol,
    baseUrl: parsed.baseUrl,
    apiKey,
    model: parsed.model
  });
  return { provider, apiKey, config: parsed };
}

export async function providerChat(messages, tools = [], options = {}) {
  const { provider, config } = await initializeProvider(options.model || '', options);
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
      const key = Number.isInteger(toolInfo.index) ? 'index:' + toolInfo.index : (toolInfo.id || 'name:' + (toolInfo.name || 'tool'));
      const existing = toolCalls.get(key) || { id: toolInfo.id || key, name: '', arguments: '' };
      if (toolInfo.id) existing.id = toolInfo.id;
      if (toolInfo.name && toolInfo.name !== 'unknown') existing.name = toolInfo.name;
      if (typeof toolInfo.args === 'string') existing.arguments += toolInfo.args;
      else if (toolInfo.args && typeof toolInfo.args === 'object') existing.arguments = JSON.stringify(toolInfo.args);
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
      // Providers stream through callbacks and terminate the iterator on completion.
      void event;
    }
  } catch (error) {
    onError(error);
    throw error;
  }

  const normalizedToolCalls = Array.from(toolCalls.values())
    .filter(call => call.name)
    .map(call => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments || '{}' }
    }));

  return {
    role: 'assistant',
    content: finalContent || null,
    ...(normalizedToolCalls.length ? { tool_calls: normalizedToolCalls } : {}),
    usage: finalUsage
  };
}

export async function chat(messages, tools = [], options = {}) {
  return providerChat(messages, tools, options);
}

export function listProviders() {
  return getProviderCatalog();
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
      if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data: ')) continue;
      const payload = trimmed.slice(6).trim();
      if (payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        if (json.usage) usage = json.usage;
        const choice = json.choices?.[0];
        if (!choice?.delta) continue;
        const delta = choice.delta;
        if (delta.content) {
          content += delta.content;
          onToken?.(delta.content);
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const index = tc.index ?? 0;
            if (!toolCallsMap[index]) {
              toolCallsMap[index] = { id: '', type: 'function', function: { name: '', arguments: '' } };
            }
            if (tc.id) toolCallsMap[index].id = tc.id;
            if (tc.function?.name) toolCallsMap[index].function.name += tc.function.name;
            if (tc.function?.arguments) toolCallsMap[index].function.arguments += tc.function.arguments;
          }
        }
      } catch {}
    }
  }

  const tool_calls = toolCallsMap.filter(Boolean);
  const estPrompt = 50;
  const estCompletion = Math.max(1, Math.ceil(content.length / 4));
  usage ||= { prompt_tokens: estPrompt, completion_tokens: estCompletion, total_tokens: estPrompt + estCompletion };
  return {
    role: 'assistant',
    content: content || null,
    ...(tool_calls.length ? { tool_calls } : {}),
    usage
  };
}
