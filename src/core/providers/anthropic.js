/**
 * Anthropic provider abstraction.
 * Anthropic API menggunakan format pesan dan tool calling yang berbeda.
 */
export class AnthropicProvider {
  constructor(config = {}) {
    this.baseUrl = config.baseUrl || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
    this.apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY || '';
    this.model = config.model || process.env.ANTHROPIC_MODEL || '';
    this.maxRetries = config.maxRetries || 3;
    this.fallbackModel = config.fallbackModel;
  }

  /**
   * Normalisasi tool call dari format Anthropic ke format internal.
   * Anthropic tool calls datang dalam array tool_calls dengan input sebagai object.
   * @param {Object} toolCall - Tool call dari Anthropic response
   * @returns {Object} Normalized tool call {id, name, arguments}
   */
  normalizeToolCall(toolCall) {
    if (!toolCall) return null;

    if (toolCall.normalized) return toolCall;

    // Anthropic format: { id, name, input: {..} }
    return {
      normalized: true,
      id: toolCall.id || toolCall.name || '',
      name: toolCall.name || 'unknown',
      arguments: JSON.stringify(toolCall.input || {})
    };
  }

  /**
   * Normalisasi format usage dari Anthropic.
   * Anthropic mengirim usage di akhir response sebagai separate object.
   * @param {Object} usage - Usage dari Anthropic response
   * @returns {Object} Normalized usage
   */
  normalizeUsage(usage) {
    if (!usage) {
      return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    }

    // Anthropic mengirim input_tokens dan output_tokens
    if (usage.input_tokens !== undefined && usage.output_tokens !== undefined) {
      return {
        prompt_tokens: usage.input_tokens,
        completion_tokens: usage.output_tokens,
        total_tokens: usage.input_tokens + usage.output_tokens
      };
    }

    // Fallback umum
    const total = usage.tokens || usage.input_tokens || 0;
    return {
      prompt_tokens: total || 0,
      completion_tokens: 0,
      total_tokens: total || 0
    };
  }

  /**
   * Stream Anthropic chat completions.
   * Anthropic menggunakan endpoint POST /v1/messages dengan streaming.
   * @param {Array} messages - Array pesan (dikonversi ke format Anthropic)
   * @param {Array} tools - Tool definitions
   * @param {Object} options - Callback options
   * @returns {AsyncIterator} Normalized event stream
   */
  async *stream(messages, tools = [], options = {}) {
    const model = options.model || this.model;
    const temperature = options.temperature;
    const onToken = options.onToken || (() => {});
    const onToolStart = options.onToolStart || (() => {});
    const onToolResult = options.onToolResult || (() => {});
    const onDone = options.onDone || (() => {});
    const onError = options.onError || ((err) => { throw err; });

    const apiKey = this.apiKey || process.env.ANTHROPIC_API_KEY || '';
    if (!apiKey) {
      throw new Error('Anthropic API key is missing');
    }

    const anthropicVersion = '2023-06-01';
    const maxTokens = 100000; // default, bisa diedit berdasarkan model

    // Convert messages to Anthropic format
    const anthropicMessages = messages.map(msg => {
      if (msg.role === 'system') {
        return { role: 'system', content: msg.content };
      }
      if (msg.role === 'assistant') {
        return { role: 'assistant', content: msg.content };
      }
      if (msg.role === 'tool') {
        return { role: 'user', content: `Tool ${msg.name} output: ${msg.content || ''}` };
      }
      return { role: 'user', content: msg.content || '' };
    });

    // Build tool definitions for Anthropic
    const anthropicTools = tools?.map(tool => ({
      name: tool.name,
      description: tool.description || '',
      input_schema: tool.parameters || { type: 'object', properties: {} }
    })) || [];

    let retryCount = 0;

    while (true) {
      try {
        const payload = {
          model,
          max_tokens: Math.min(maxTokens, 100000),
          temperature,
          stream: true,
          system: anthropicMessages.find(m => m.role === 'system')?.content || '',
          messages: anthropicMessages.filter(m => m.role !== 'system'),
          tools: anthropicTools.length > 0 ? anthropicTools : undefined
        };

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);

        const response = await fetch(`${this.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/messages`, {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': anthropicVersion,
            'content-type': 'application/json'
          },
          body: JSON.stringify(payload),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (response.status === 429) {
          if (retryCount < this.maxRetries) {
            retryCount++;
            const waitTime = Math.pow(2, retryCount) * 500;
            console.warn(`[Anthropic Provider] Rate limit, retry after ${waitTime}ms`);
            await new Promise(r => setTimeout(r, waitTime));
            continue;
          }
          throw new Error('Max retries reached for 429');
        }

        if (response.status >= 500) {
          if (retryCount < this.maxRetries) {
            retryCount++;
            const waitTime = Math.pow(2, retryCount) * 500;
            await new Promise(r => setTimeout(r, waitTime));
            continue;
          }
          const errText = await response.text();
          throw new Error(`Anthropic server error: ${errText}`);
        }

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`HTTP ${response.status}: ${errText}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        // Track tool call state
        let toolCallIndex = 0;
        const toolCallsMap = {};

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(':')) continue;
            if (!trimmed.startsWith('data: ')) continue;

            const payloadStr = trimmed.slice(6).trim();
            if (payloadStr === '[DONE]') {
              onDone?.({ finishReason: 'stop' });
              return;
            }

            try {
              const json = JSON.parse(payloadStr);

              // Process content delta
              if (json.content) {
                onToken?.(json.content, json.content);
              }

              // Process tool use/delta
              if (json.type === 'tool_use') {
                // First appearance of a tool call
                if (!toolCallsMap[json.id]) {
                  toolCallsMap[json.id] = {
                    id: json.id,
                    name: json.name,
                    args: {},
                    callIndex: toolCallIndex++
                  };
                  onToolStart?.({
                    id: json.id,
                    name: json.name,
                    args: {}
                  });
                }

                // Update arguments
                if (json.input) {
                  toolCallsMap[json.id].args = json.input;
                  // Re-emit with updated args
                  onToolStart?.({
                    id: json.id,
                    name: json.name,
                    args: json.input
                  });
                }
              }

              if (json.type === 'tool_delta') {
                // Streaming delta dari tool result
                if (json.delta) {
                  // Emit partial result
                }
              }

              // Finish response
              if (json.type === 'message_delta') {
                if (json.usage) {
                  const normalized = this.normalizeUsage(json.usage);
                  onToken?.(json.delta || '', normalized);
                }
                onDone?.({
                  finishReason: json.stop_reason,
                  usage: normalized || {}
                });
                return; // Selesai iterator
              }

              // Jika ada tool calls yang finished
              if (json.type === 'message_stop') {
                onDone?.({ finishReason: 'end_turn' });
                return;
              }

            } catch (err) {
              continue; // Skip parse errors
            }
          }
        }

        // Jika stream selesai tapi belum emit done
        onDone?.({ finishReason: 'stop' });

      } catch (err) {
        if (retryCount >= this.maxRetries) {
          onError?.(err);
          throw err;
        }
        retryCount++;
        const waitTime = Math.pow(2, retryCount) * 500;
        await new Promise(r => setTimeout(r, waitTime));
        continue; // Retry
      }
    }
  }
}