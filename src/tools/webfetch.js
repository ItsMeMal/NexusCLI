/**
 * Tool webfetch: Ambil konten web dengan batas ukuran dan konversi ke teks bersih
 */

const DEFAULT_MAX_SIZE = 100 * 1024; // 100 KB limit
const DEFAULT_TIMEOUT_MS = 15000;    // 15 seconds timeout

/**
 * Konversi HTML sederhana ke teks bersih tanpa dependensi eksternal
 */
export function htmlToText(html) {
  if (typeof html !== 'string') return '';

  return html
    // 1. Hapus script & style tags beserta isinya
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, '')
    // 2. Ganti line-breaking tags dengan newline
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n')
    .replace(/<br\s*[\/]?>/gi, '\n')
    .replace(/<hr\s*[\/]?>/gi, '\n---\n')
    // 3. Hapus semua HTML tags yang tersisa
    .replace(/<[^>]+>/g, '')
    // 4. Decode common HTML entities
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    // 5. Normalisasi spasi dan baris kosong berlebih
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

export const webfetchTool = {
  name: 'webfetch',
  description: 'Fetch content from a web URL (HTTP/HTTPS) with strict size limits and automatic conversion from HTML to clean plain text. Useful for reading documentation, API specifications, and web pages.',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The HTTP or HTTPS URL to fetch'
      },
      maxBytes: {
        type: 'number',
        description: 'Maximum response size in bytes (default: 102400 / 100KB)'
      },
      format: {
        type: 'string',
        enum: ['text', 'raw'],
        description: 'Format output: "text" (stripped HTML plain text, default) or "raw"'
      }
    },
    required: ['url']
  },

  async execute({ url, maxBytes = DEFAULT_MAX_SIZE, format = 'text' }, ctx = {}) {
    if (!url || typeof url !== 'string') {
      return 'Error: "url" parameter is required.';
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      return `Error: Invalid URL "${url}". Must include protocol (e.g. http:// or https://).`;
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return `Error: Unsupported protocol "${parsedUrl.protocol}". Only http: and https: are allowed.`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Nexus-Agent/0.1.0 (WebFetch; +https://github.com/nexus-cli)',
          'Accept': 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8'
        }
      });

      clearTimeout(timer);

      if (!response.ok) {
        return `Error: HTTP request to ${url} failed with status ${response.status} (${response.statusText})`;
      }

      // Check Content-Length header if present
      const contentLengthHeader = response.headers.get('content-length');
      if (contentLengthHeader && parseInt(contentLengthHeader, 10) > maxBytes) {
        return `Error: Response Content-Length (${contentLengthHeader} bytes) exceeds limit (${maxBytes} bytes).`;
      }

      // Read response body with streaming size enforcement
      const reader = response.body?.getReader();
      if (!reader) {
        const text = await response.text();
        return formatOutput(text, format, maxBytes);
      }

      const chunks = [];
      let totalBytes = 0;
      let truncated = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (totalBytes + value.length > maxBytes) {
          const sliceNeeded = maxBytes - totalBytes;
          if (sliceNeeded > 0) {
            chunks.push(value.subarray(0, sliceNeeded));
            totalBytes += sliceNeeded;
          }
          truncated = true;
          try { await reader.cancel(); } catch {}
          break;
        }

        chunks.push(value);
        totalBytes += value.length;
      }

      const totalBuffer = Buffer.concat(chunks);
      const rawText = totalBuffer.toString('utf-8');

      let resultText = format === 'raw' ? rawText : htmlToText(rawText);

      if (truncated) {
        resultText += `\n\n[Peringatan: Konten webfetch dipotong karena melebihi batas ${maxBytes} bytes]`;
      }

      return resultText || '(Konten web kosong)';
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        return `Error: Web fetch timed out after ${DEFAULT_TIMEOUT_MS / 1000}s for URL: ${url}`;
      }
      return `Error fetching URL ${url}: ${err.message}`;
    }
  }
};

function formatOutput(rawText, format, maxBytes) {
  let truncated = false;
  let text = rawText;
  if (text.length > maxBytes) {
    text = text.slice(0, maxBytes);
    truncated = true;
  }
  let result = format === 'raw' ? text : htmlToText(text);
  if (truncated) {
    result += `\n\n[Peringatan: Konten webfetch dipotong karena melebihi batas ${maxBytes} bytes]`;
  }
  return result || '(Konten web kosong)';
}
