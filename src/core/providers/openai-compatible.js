export class OpenAICompatibleProvider {
  constructor(config = {}) {
    this.baseUrl = String(config.baseUrl || '').replace(/\/+$/, '');
    this.apiKey = config.apiKey || '';
    this.model = config.model || '';
    this.maxRetries = config.maxRetries || 3;
    this.fallbackModel = config.fallbackModel;
  }

  normalizeToolCall(toolCall) {
    if (!toolCall) return null;
    if (toolCall.normalized) return toolCall;
    if (toolCall.type === 'function' || toolCall.type === 'code_interpreter') {
      return {
        normalized: true,
        id: toolCall.id || toolCall.name,
        name: toolCall.function?.name || toolCall.name || '',
        arguments: toolCall.function?.arguments || '{}'
      };
    }
    return {
      normalized: true,
      id: toolCall.id || '',
      name: toolCall.name || 'unknown',
      arguments: toolCall.input !== undefined ? JSON.stringify(toolCall.input)
        : (toolCall.parameters !== undefined ? JSON.stringify(toolCall.parameters) : '{}')
    };
  }

  normalizeUsage(usage) {
    if (!usage) return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    if (usage.prompt_tokens !== undefined || usage.completion_tokens !== undefined) {
      const prompt = usage.prompt_tokens || 0;
      const completion = usage.completion_tokens || 0;
      return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: usage.total_tokens || prompt + completion };
    }
    if (usage.input_tokens !== undefined || usage.output_tokens !== undefined) {
      const prompt = usage.input_tokens || 0;
      const completion = usage.output_tokens || 0;
      return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: usage.total_tokens || prompt + completion };
    }
    return { prompt_tokens: usage.tokens || 0, completion_tokens: 0, total_tokens: usage.tokens || 0 };
  }

  async *stream(messages, tools = [], options = {}) {
    if (!this.baseUrl) throw new Error('Provider base URL is not configured.');
    if (!this.apiKey) throw new Error('Provider API key is not configured.');
    const model = options.model || this.model;
    if (!model) throw new Error('No model selected. Use /model to choose a model from a configured provider.');

    const payload = { model, messages, stream: true };
    if (Array.isArray(tools) && tools.length) {
      payload.tools = tools;
      payload.tool_choice = 'auto';
    }
    if (options.temperature !== undefined) payload.temperature = options.temperature;

    const response = await fetch(this.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + this.apiKey
      },
      body: JSON.stringify(payload),
      signal: options.signal
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error('Provider HTTP ' + response.status + (detail ? ': ' + detail.slice(0, 1200) : ''));
    }
    if (!response.body?.getReader) throw new Error('Provider response does not support streaming.');

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    const toolCalls = new Map();
    let usage = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;
        let event;
        try { event = JSON.parse(data); } catch { continue; }
        if (event.usage) usage = this.normalizeUsage(event.usage);
        const delta = event.choices?.[0]?.delta;
        if (typeof delta?.content === 'string') options.onToken?.(delta.content);
        for (const chunk of delta?.tool_calls || []) {
          const index = chunk.index ?? 0;
          const current = toolCalls.get(index) || { id: '', name: '', arguments: '' };
          if (chunk.id) current.id = chunk.id;
          if (chunk.function?.name) current.name += chunk.function.name;
          if (chunk.function?.arguments) current.arguments += chunk.function.arguments;
          toolCalls.set(index, current);
        }
      }
    }

    for (const [index, call] of toolCalls) {
      options.onToolStart?.({
        index,
        id: call.id || ('tool_' + index),
        name: call.name,
        args: call.arguments
      });
    }
    options.onDone?.({ finishReason: 'stop', usage });
    yield { type: 'done', usage };
  }
}
