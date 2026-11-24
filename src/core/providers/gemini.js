/**
 * Gemini provider abstraction.
 * Gemini API (Google Generative AI) menggunakan format pesan dan tool calling yang berbeda.
 */
export class GeminiProvider {
  constructor(config = {}) {
    this.baseUrl = config.baseUrl || process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
    this.apiKey = config.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
    this.model = config.model || process.env.GEMINI_MODEL || 'gemini-1.5-flash';
    this.maxRetries = config.maxRetries || 3;
    this.fallbackModel = config.fallbackModel;
  }

  /**
   * Normalisasi tool call dari Gemini ke format internal.
   * Gemini tool calls datang sebagai function_declarations dan dari delta.tool_calls.
   * @param {Object} toolCall - Tool call dari Gemini response
   * @returns {Object} Normalized tool call
   */
  normalizeToolCall(toolCall) {
    if (!toolCall) return null;

    if (toolCall.normalized) return toolCall;

    // Gemini format dari function calling
    if (toolCall.name && toolCall.parameters !== undefined) {
      return {
        normalized: true,
        id: toolCall.id || toolCall.name,
        name: toolCall.name,
        arguments: JSON.stringify(toolCall.parameters || {})
      };
    }

    // Fallback format dari delta
    if (toolCall.id && toolCall.function) {
      return {
        normalized: true,
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.parameters || '{}'
      };
    }

    // Fallback lain
    return {
      normalized: true,
      id: toolCall.id || '',
      name: toolCall.name || 'unknown',
      arguments: '{}'
    };
  }

  /**
   * Normalisasi format usage dari Gemini.
   * @param {Object} usage - Usage dari Gemini response
   * @returns {Object} Normalized usage
   */
  normalizeUsage(usage) {
    if (!usage) {
      return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    }

    // Gemini mengirim prompt_token_count dan candidates[0].output_token_count
    if (usage.prompt_token_count !== undefined && usage.candidates?.[0]?.output_token_count !== undefined) {
      return {
        prompt_tokens: usage.prompt_token_count,
        completion_tokens: usage.candidates[0].output_token_count,
        total_tokens: usage.prompt_token_count + usage.candidates[0].output_token_count
      };
    }

    // Fallback jika ada total_tokens
    if (usage.total_tokens !== undefined) {
      return {
        prompt_tokens: usage.prompt_tokens || 0,
        completion_tokens: usage.completion_tokens || 0,
        total_tokens: usage.total_tokens
      };
    }

    // Default fallback
    return {
      prompt_tokens: usage.tokens || 0,
      completion_tokens: 0,
      total_tokens: usage.tokens || 0
    };
  }

  /**
   * Stream Gemini chat completions.
   * Gemini menggunakan format: GET https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?key={key}
   * @param {Array} messages - Array pesan
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

    const apiKey = this.apiKey || process.env.GEMINI_API_KEY || '';
    if (!apiKey) {
      throw new Error('Gemini API key is missing');
    }

    // Convert messages to Gemini format (simplified)
    // Gemini expects a specific conversation format
    const geminiContents = messages.map(msg => {
      const role = msg.role === 'user' ? 'user' : msg.role === 'assistant' ? 'model' : 'user';
      return { role, parts: [{ text: msg.content || '' }] };
    });

    // Build tool declarations
    const geminiTools = tools?.map(tool => ({
      function_declarations: [{
        name: tool.name,
        description: tool.description || '',
        parameters: tool.parameters || { type: 'object', properties: {} }
      }]
    })) || [];

    let retryCount = 0;

    while (true) {
      try {
        // Build the request URL with key parameter
        const keyParam = `key=${apiKey}`;
        const url = `${this.baseUrl}/v1beta/models/${model}:streamGenerateContent?${keyParam}`;

        const payload = {
          contents: geminiContents,
          generationConfig: {
            temperature,
            maxOutputTokens: 8192
          },
          tools: geminiTools.length > 0 ? geminiTools : undefined,
          tool_config: { /* tool configuration */ }
        };

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (response.status === 429) {
          if (retryCount < this.maxRetries) {
            retryCount++;
            const waitTime = Math.pow(2, retryCount) * 1000;
            console.warn(`[Gemini Provider] Rate limit, retry after ${waitTime}ms`);
            await new Promise(r => setTimeout(r, waitTime));
            continue;
          }
          throw new Error('Max retry attempts reached for 429');
        }

        if (response.status >= 500) {
          if (retryCount < this.maxRetries) {
            retryCount++;
            const waitTime = Math.pow(2, retryCount) * 1000;
            await new Promise(r => setTimeout(r, waitTime));
            continue;
          }
          const errText = await response.text();
          throw new Error(`Gemini server error: ${errText}`);
        }

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`HTTP ${response.status}: ${errText}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        // Gemini streaming emits chunks with index-based tool calls
        let toolCallIndex = 0;
        const activeToolCalls = {};

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('0:')) continue; // Gemini prefixed lines
            if (!trimmed.startsWith('data: ')) continue;

            const payloadStr = trimmed.slice(6).trim();
            if (payloadStr === '[DONE]') {
              onDone?.({ finishReason: 'stop' });
              return;
            }

            try {
              const json = JSON.parse(payloadStr);

              // Process content
              if (json.text) {
                onToken?.(json.text, json.text);
              }

              // Process tool calls from delta
              if (json.makers && json.makers.includes('tool-calls')) {
                // Handle tool call deltas
                if (json.tool_calls && Array.isArray(json.tool_calls)) {
                  for (const tc of json.tool_calls) {
                    const normalized = this.normalizeToolCall(tc);
                    if (normalized) {
                      // Initialize tool call if not exists
                      if (!activeToolCalls[normalized.id]) {
                        activeToolCalls[normalized.id] = {
                          id: normalized.id,
                          name: normalized.name,
                          args: {}
                        };
                        onToolStart?.({
                          id: normalized.id,
                          name: normalized.name,
                          args: {}
                        });
                      }

                      // Update arguments
                      if (normalized.arguments !== '{}') {
                        activeToolCalls[normalized.id].args = JSON.parse(normalized.arguments);
                        onToolStart?.({
                          id: normalized.id,
                          name: normalized.name,
                          args: JSON.parse(normalized.arguments)
                        });
                      }
                    }
                  }
                }
              }

              // Finish response
              if (json.finishReason) {
                const normalizedUsage = this.normalizeUsage(json.usageInfo);
                onToken?.('', normalizedUsage);
                onDone?.({
                  finishReason: json.finishReason,
                  usage: normalizedUsage
                });
                return; // Selesai iterator
              }

            } catch (err) {
              continue; // Skip parse errors
            }
          }
        }

        // Jika stream selesai tanpa finishReason explicit
        onDone?.({ finishReason: 'stop' });

      } catch (err) {
        if (retryCount >= this.maxRetries) {
          onError?.(err);
          throw err;
        }
        retryCount++;
        const waitTime = Math.pow(2, retryCount) * 1000;
        await new Promise(r => setTimeout(r, waitTime));
        continue; // Retry
      }
    }
  }
}