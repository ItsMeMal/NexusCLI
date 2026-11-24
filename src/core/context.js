import { chat } from './llm.js';

const DEFAULT_MAX_TOKENS = 8192;
const COMPACTION_THRESHOLD_RATIO = 0.8; // 80% of max tokens
const MESSAGES_TO_PRESERVE = 6; // Keep last N messages + system prompt

/**
 * Estimasi jumlah token dari teks.
 * Pendekatan sederhana: ~4 karakter per token untuk teks English.
 * Untuk kode program kemungkinan lebih tinggi, jadi gunakan perhitungan yang lebih baik.
 * @param {string} text - Teks untuk diestimasi token-nya
 * @returns {number} Estimasi token
 */
export function estimateTokens(text) {
  if (typeof text !== 'string') return 0;
  // Huruf/karakter rata-rata 4 per token, tapi kode program bisa lebih banyak
  // Gunakan perhitungan yang lebih akurat untuk kode (~3.5 char/tok) dan teks biasa (4+ char/tok)
  const codeRatio = (text.match(/```|function|const|let|var|return|if|for|while|class|import|export/g) || []).length;
  const avgCharPerToken = codeRatio > 0 ? 3.5 : 4.0;
  return Math.max(1, Math.ceil(text.length / avgCharPerToken));
}

/**
 * Estimasi total token dari array pesan.
 * @param {Array} messages - Array objek pesan role/content
 * @returns {number} Total estimated tokens
 */
export function estimateMessagesTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (const msg of messages) {
    if (!msg || !msg.content) continue;
    total += estimateTokens(msg.content);
    // Tambahkan overhead per pesan (role, metadata, etc.)
    total += 3; // overhead per message
  }
  return total;
}

/**
 * Mendapatkan konfigurasi model (maksimal token dan harga).
 * @param {string} model - Nama model (default: Elaina-Free)
 * @returns {Object} Konfigurasi model dengan max tokens dan harga per 1M token
 */
export function getModelConfig(model) {
  const modelLower = (model || 'Elaina-Free').toLowerCase();

  // Pricing dan max tokens per model (harga per 1M input/output token USD)
  const modelConfigs = {
    'elaina-free': { maxTokens: 8192, inputPrice: 0, outputPrice: 0, name: 'Elaina-Free' },
    'gpt-4o': { maxTokens: 128000, inputPrice: 5.00, outputPrice: 15.00, name: 'GPT-4o' },
    'gpt-4o-mini': { maxTokens: 128000, inputPrice: 0.150, outputPrice: 0.600, name: 'GPT-4o-mini' },
    'gpt-4': { maxTokens: 8192, inputPrice: 30.00, outputPrice: 60.00, name: 'GPT-4' },
    'gpt-3.5-turbo': { maxTokens: 16385, inputPrice: 0.50, outputPrice: 1.50, name: 'GPT-3.5-turbo' },
    'claude-3-opus': { maxTokens: 200000, inputPrice: 15.00, outputPrice: 75.00, name: 'Claude-3-Opus' },
    'claude-3-sonnet': { maxTokens: 200000, inputPrice: 3.00, outputPrice: 15.00, name: 'Claude-3-Sonnet' },
    'claude-3-haiku': { maxTokens: 200000, inputPrice: 0.25, outputPrice: 1.25, name: 'Claude-3-Haiku' },
  };

  return modelConfigs[modelLower] || {
    maxTokens: DEFAULT_MAX_TOKENS,
    inputPrice: 0,
    outputPrice: 0,
    name: model || 'Unknown Model'
  };
}

/**
 * Menghitung persentase konteks yang digunakan dari total kapasitas model.
 * @param {Array} messages - Array pesan
 * @param {string} model - Nama model
 * @returns {Object} Objektur dengan usedTokens, maxTokens, usageRatio, exceeded
 */
export function calculateContextUsage(messages, model) {
  const config = getModelConfig(model);
  const usedTokens = estimateMessagesTokens(messages);
  const maxTokens = config.maxTokens || DEFAULT_MAX_TOKENS;
  const usageRatio = maxTokens > 0 ? usedTokens / maxTokens : 1;
  
  return {
    usedTokens,
    maxTokens,
    usageRatio: Math.round(usageRatio * 100) / 100, // 2 desimal
    exceeded: usageRatio > COMPACTION_THRESHOLD_RATIO,
    thresholdRatio: COMPACTION_THRESHOLD_RATIO,
    modelName: config.name
  };
}

/**
 * Memecah array pesan menjadi 3 bagian:
 * 1. Messages that can be summarized (old messages)
 * 2. Messages to preserve (last N messages + system prompt)
 * @param {Array} messages - Semua pesan
 * @param {number} n - Jumlah pesan terakhir yang harus dijaga
 * @returns {Object} { summarizable, toPreserve }
 */
function partitionMessages(messages, n = MESSAGES_TO_PRESERVE) {
  if (!Array.isArray(messages) || messages.length <= n) {
    return { summarizable: [], toPreserve: messages };
  }
  
  // Pesan terakhir yang harus dijaga (including possible system prompt di akhir)
  const toPreserve = messages.slice(-n);
  
  // Pesan yang bisa direkomendasikan untuk diremoving/ringkas
  // Kecuali jika ada system prompt di awal, simpan itu juga
  let summarizable = messages.slice(0, -n);
  
  // Pastikan system prompt (pesan pertama dengan role 'system') tidak pernah diremoving
  // Cari dan tempatkan system prompt ke dalam toPreserve
  const systemPromptIdx = summarizable.findIndex(msg => msg && msg.role === 'system');
  if (systemPromptIdx >= 0) {
    // Pindahkan system prompt ke toPreserve (pastikan hanya 1 system prompt)
    const systemPrompt = summarizable.splice(systemPromptIdx, 1)[0];
    // Masukkan ke awal toPreserve jika belum ada system prompt
    if (toPreserve.findIndex(msg => msg && msg.role === 'system') < 0) {
      toPreserve.unshift(systemPrompt);
    }
    // Recalculate summarizable setelah splice
    summarizable = messages.slice(0, -n);
  }
  
  return { summarizable, toPreserve };
}

/**
 * Membuat ringkasan pesan lama menggunakan LLM terpisah.
 * @param {Array} oldMessages - Pesan lama yang akan diremrapikan
 * @param {string} model - Nama model untuk pemanggil ringkasan
 * @param {Function} onProgress - Callback untuk progress (opsional)
 * @returns {Promise<string>} Ringkasan teks dari pesan lama
 */
export async function summarizeMessages(oldMessages, model, onProgress) {
  if (!oldMessages || oldMessages.length === 0) return '';
  
  // Filter messages yang punya content
  const msgsWithContent = oldMessages.filter(m => m && m.content);
  if (msgsWithContent.length === 0) return '';
  
  // Siapkan konteks ringkasan: tampilin saja content yang penting, buang detail yang tak perlu
  const summaryPrompt = `Summarize the following conversation history into a concise briefing (max 200 words). 
Focus on:
- User requests and goals
- Key decisions made
- Tool calls and their outcomes (success/failure)
- Important findings or errors
- Current state and what remains to be done

RESPOND ONLY with the summary text, no analysis or additional formatting.

--- CONVERSATION HISTORY START ---
${msgsWithContent.slice(0, 20).map((m, i) => 
  `Message ${i+1} [${m.role}]: ${m.content.substring(0, 300).replace(/\n/g, ' ')}...`
).join('\n---')} 
--- CONVERSATION HISTORY END ---`;

  try {
    const summaryMsg = await chat([
      { role: 'system', content: 'Anda adalah Nexus AI Technical Partner. Ringkaslah riwayat percakapan di atas menjadi briefing yang padat dan bisa dibaca kembali dalam 30 detik. Fokus pada intent user, keputusan kunci, hasil tool call, dan state akhir.' },
      { role: 'user', content: summaryPrompt }
    ], [], { model, skipApiKeyCheck: true });

    if (summaryMsg && summaryMsg.content) {
      return summaryMsg.content.trim();
    }
    return '';
  } catch (err) {
    console.warn('[Context] Gagal membuat ringkasan via LLM:', err.message);
    // Fallback: ringkasan manual sederhana
    const manualSummary = msgsWithContent
      .slice(0, 10)
      .map(m => `${m.role}: ${m.content ? m.content.substring(0, 100) : ''}`.trim())
      .join(' | ');
    return manualSummary || '';
  }
}

/**
 * Menerapkan pruning/cleaning pada output tool lama.
 * Gantikan output terlalu besar dengan placeholder.
 * @param {Array} messages - Array pesan
 * @param {number} maxOutputLength - Panjang maksimum output sebelum dipotong
 * @returns {Array} Pesan yang sudah di-prune
 */
export function pruneOldOutputs(messages, maxOutputLength = 500) {
  if (!Array.isArray(messages)) return messages;
  
  const pruned = messages.map(msg => {
    if (!msg || !msg.content) return msg;
    
    // Jika pesan dari tool/tool_result dan output terlalu panjang
    // Role 'tool' digunakan untuk tool call results, 'tool_result' untuk backward compat
    const isToolMsg = msg.role === 'tool' || msg.role === 'tool_result';
    
    if (isToolMsg && msg.output) {
      if (msg.output.length > maxOutputLength) {
        const truncated = msg.output.substring(0, maxOutputLength);
        return {
          ...msg,
          output: `[output dipangkas - output asli ${msg.output.length} chars dipotong]`
        };
      }
    }
    return msg;
  });
  
  return pruned;
}

/**
 * Main compaction function: Cek apakah konteks melebihi threshold,
 * dan jika ya, jalankan compaction.
 * @param {Array} messages - Array pesan saat ini
 * @param {string} model - Nama model
 * @param {Object} options - Opsi tambahan
 * @param {Function} options.onCompaction - Callback saat compaction berlangsung
 * @returns {Promise<Array>} Pesan yang sudah dikompak atau asli jika tidak perlu
 */
export async function compactContextIfNeeded(messages, model, onCompaction) {
  const usage = calculateContextUsage(messages, model);
  
  // Jika belum melebihi threshold, tidak perlu compaction
  if (!usage.exceeded) {
    return { messages, compacted: false, usage };
  }
  
  // Partisi pesan: mana yang bisa diremoving dan mana yang harus dijaga
  const { summarizable, toPreserve } = partitionMessages(messages);
  
  if (summarizable.length === 0) {
    // Tidak ada pesan yang bisa diremoving, tapi masih melebihi threshold
    // Lakukan pruning output saja
    const pruned = pruneOldOutputs(messages);
    return { messages: pruned, compacted: false, usage, pruned: true };
  }
  
  // Jalankan ringkasan pesan lama
  onCompaction?.({
    type: 'starting',
    summarizableCount: summarizable.length,
    currentUsageRatio: usage.usageRatio,
    model
  });
  
  const summary = await summarizeMessages(summarizable, model, onCompaction);
  
  onCompaction?.({
    type: 'summary_ready',
    summary,
    summarizableCount: summarizable.length
  });
  
  // Buat pesan ringkasan sebagai pesan baru
  const summaryMessage = {
    role: 'system',
    content: `SUMMARY OF PREVIOUS CONVERSATION (auto-compacted): ${summary}`
  };
  
  // Gabungkan: system prompt + last N messages + summary message
  const newMessages = [
    ...toPreserve,      // Last N messages (already includes system prompt if present)
    summaryMessage    // New summary message
  ];
  
  onCompaction?.({
    type: 'completed',
    newMessageCount: newMessages.length,
    newUsageRatio: calculateContextUsage(newMessages, model).usageRatio
  });
  
  return {
    messages: newMessages,
    compacted: true,
    usage,
    summary,
    newUsageRatio: calculateContextUsage(newMessages, model).usageRatio
  };
}

/**
 * Mendapatkan estimasi biaya untuk sesi saat ini.
 * @param {Array} messages - Array pesan
 * @param {string} model - Nama model
 * @returns {Object} Estimasi biaya dalam USD
 */
export function calculateCost(messages, model) {
  const config = getModelConfig(model);
  const usedTokens = estimateMessagesTokens(messages);
  
  if (config.inputPrice <= 0 && config.outputPrice <= 0) {
    return {
      inputCost: 0,
      outputCost: 0,
      totalCost: 0,
      inputTokens: usedTokens,
      outputTokens: 0,
      modelName: config.name
    };
  }
  
  // Estimasi: setengah prompt, setengah completion (approximation)
  const inputTokens = Math.floor(usedTokens * 0.5);
  const outputTokens = Math.floor(usedTokens * 0.5);
  
  const inputCost = (inputTokens / 1000000) * config.inputPrice;
  const outputCost = (outputTokens / 1000000) * config.outputPrice;
  const totalCost = inputCost + outputCost;
  
  return {
    inputCost: Math.round(inputCost * 100000) / 100000, // 5 desimal
    outputCost: Math.round(outputCost * 100000) / 100000,
    totalCost: Math.round(totalCost * 100000) / 100000,
    inputTokens,
    outputTokens,
    modelName: config.name
  };
}

/**
 * Mendapatkan ringkasan kapasitas konteks untuk display UI.
 * @param {Object} usage - Objektur dari calculateContextUsage
 * @returns {string} String deskripsi untuk ditampilkan
 */
function formatUsageDescription(usage) {
  const { usedTokens, maxTokens, usageRatio, modelName, exceeded } = usage;
  const status = exceeded ? '⚠ OVER' : '✓ OK';
  return `${status} | ${modelName}: ${usedTokens.toLocaleString()} / ${maxTokens.toLocaleString()} token (${(usageRatio * 100).toFixed(1)}%)`;
}

export { formatUsageDescription };

/**
 * Deteksi apakah message adalah tool output yang besar yang seharusnya di-prune.
 * @param {Object} msg - Objek pesan
 * @returns {boolean} true jika pesan seharusnya di-prune
 */
export function shouldPruneMessage(msg) {
  if (!msg) return false;
  if (msg.role !== 'tool_result') return false;
  if (!msg.output) return false;
  // Prune jika output lebih dari 300 karakter
  return msg.output.length > 300;
}