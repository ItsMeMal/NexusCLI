import { chat } from '../llm.js';

/**
 * OpenAI-compatible provider abstraction.
 * Semua provider OpenAI-compatible (OpenAI, OpenRouter, dll) harus implementasi interface ini.
 */
export class OpenAICompatibleProvider {
  constructor(config = {}) {
    this.baseUrl = config.baseUrl || process.env.BASE_URL || 'https://api.openai.com/v1';
    this.apiKey = config.apiKey || process.env.API_KEY || process.env.OPENAI_API_KEY || '';
    this.model = config.model || process.env.MODEL || process.env.OPENAI_MODEL || 'gpt-4o';
    this.maxRetries = config.maxRetries || 3;
    this.fallbackModel = config.fallbackModel; // optional fallback model string
  }

  /**
   * Normalisasi format tool call antar provider.
   * OpenAI: tool_calls[index].function.name/arguments
   * Anthropic: tool_calls[index].name/input
   * Gemini: tool_calls[index].function.declaration.name/parameters
   * @param {Object} toolCall - Tool call dari response provider
   * @returns {Object} Normalized tool call
   */
  normalizeToolCall(toolCall) {
    if (!toolCall) return null;

    // Jika sudah format normalized, return 그대로
    if (toolCall.normalized) return toolCall;

    // OpenAI format
    if (toolCall.type === 'function' || toolCall.type === 'code_interpreter') {
      return {
        normalized: true,
        id: toolCall.id || toolCall.name,
        name: toolCall.function?.name || toolCall.name,
        arguments: toolCall.function?.arguments || '{}'
      };
    }

    // Fallback: coba deteksi format apa
    const result = {
      normalized: true,
      id: toolCall.id || '',
      name: toolCall.name || 'unknown',
      arguments: '{}'
    };

    // Coba ekstrak dari format apa saja
    if (toolCall.input !== undefined) {
      result.arguments = JSON.stringify(toolCall.input);
    }
    if (toolCall.parameters !== undefined) {
      result.arguments = JSON.stringify(toolCall.parameters);
    }

    return result;
  }

  /**
   * Normalisasi format usage/token response.
   * @param {Object} usage - Usage dari response provider
   * @returns {Object} Normalized usage {prompt, completion, total}
   */
  normalizeUsage(usage) {
    if (!usage) {
      return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    }

    // OpenAI format
    if (usage.prompt_tokens !== undefined && usage.completion_tokens !== undefined) {
      return {
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens || (usage.prompt_tokens + usage.completion_tokens)
      };
    }

    // Format gabungan
    if (usage.input_tokens !== undefined && usage.output_tokens !== undefined) {
      return {
        prompt_tokens: usage.input_tokens,
        completion_tokens: usage.output_tokens,
        total_tokens: usage.total_tokens || (usage.input_tokens + usage.output_tokens)
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
   * Stream chat completions dengan event normalization.
   * Mengembalikan async iterator yang emisikan event ternormalisasi.
   * @param {Array} messages - Array pesan chat
   * @param {Array} tools - Daftar tool definitions (optional)
   * @param {Object} options - opsi { model, temperature, onToken, onToolStart, onToolResult, onDone, onError }
   * @returns {AsyncIterator} Async iterator yang emisikan { type, ... } events
   */
  async *stream(messages, tools = [], options = {}) {
    const model = options.model || this.model;
    const temperature = options.temperature;
    const onToken = options.onToken || (() => {});
    const onToolStart = options.onToolStart || (() => {});
    const onToolResult = options.onToolResult || (() => {});
    const onDone = options.onDone || (() => {});
    const onError = options.onError || ((err) => { throw err; });

    let retryCount = 0;
    let lastAttempt = 0;

    const executeRequest = async () => {
      const payload = {
        model,
        messages,
        stream: true
      };

      if (tools && tools.length > 0) {
        payload.tools = tools;
        payload.tool_choice = 'auto';
      }

      if (temperature !== undefined) {
        payload.temperature = temperature;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`
          },
          body: JSON.stringify(payload),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (response.status === 429) {
          // Rate limit - exponential backoff
          const waitTime = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s...
          if (retryCount < this.maxRetries) {
            retryCount++;
            console.warn(`[Provider] Rate limit 429, retry after ${waitTime}ms (attempt ${retryCount})`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            return; // retry dari awal
          } else {
            throw new Error('Max retry attempts reached for rate limit 429');
          }
        }

        if (response.status >= 500) {
          // Server error - retry with backoff
          if (retryCount < this.maxRetries) {
            retryCount++;
            const waitTime = Math.pow(2, retryCount) * 1000;
            console.warn(`[Provider] Server error ${response.status}, retry after ${waitTime}ms`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            return; // retry
          }
        }

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

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
            if (payloadStr === '[DONE]') continue;

            try {
              const json = JSON.parse(payloadStr);

              // Normalize usage
              if (json.usage) {
                const normalizedUsage = this.normalizeUsage(json.usage);
                onToken?.(json.usage || '', normalizedUsage);
              }

              // Process content delta
              if (json.choices?.[0]?.delta?.content) {
                onToken?.(json.choices[0].delta.content, json.choices[0].delta.content);
              }

              // Process tool calls
              if (Array.isArray(json.choices?.[0]?.delta?.tool_calls)) {
                for (const tc of json.choices[0].delta.tool_calls) {
                  const normalized = this.normalizeToolCall(tc);
                  if (normalized) {
                    onToolStart?.({
                      id: normalized.id,
                      name: normalized.name,
                      args: normalized.arguments
                    });
                  }
                }
              }

              // Process finished tool calls (post-processing)
              if (json.choices?.[0]?.finish_reason) {
                onDone?.({
                  finishReason: json.choices[0].finish_reason,
                  usage: this.normalizeUsage(json.usage)
                });
                return; // Selesaikan iterator
              }

            } catch (err) {
              // Skip unparseable delta
              continue;
            }
          }
        }

        // Selesaikan jika stream selesai tanpa finish_reason
        onDone?.({
          finishReason: 'stop',
          usage: this.normalizeUsage({})
        });

      } catch (err) {
        // Jika rate limit sudah max retry, atau error lain
        if (retryCount >= this.maxRetries) {
          onError?.(err);
          throw err;
        }

        // Coba retry sekali lagi
        retryCount++;
        const waitTime = Math.pow(2, retryCount) * 1000;
        await new Promise(resolve => setTimeout(resolve, waitTime));
        // Restart stream dari awal
        await this.stream(messages, tools, options);
      }
    };

    // Jalankan request dengan retry loop
    while (true) {
      try {
        await executeRequest();
        break; // Sukses, keluar dari retry loop
      } catch (err) {
        // Jika error bukan rate limit atau sudah habis retry
        if (err.message && err.message.includes('Max retry attempts')) {
          onError?.(err);
          throw err;
        }

        // Retry lain
        retryCount++;
        if (retryCount > this.maxRetries) {
          onError?.(err);
          throw err;
        }
        const waitTime = Math.pow(2, retryCount) * 1000;
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
}