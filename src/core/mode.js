/**
 * Resolve the execution route for an Auto-mode user turn.
 *
 * Auto is deliberately conservative: only a clear request to perform an
 * action enters build mode. Questions, reviews, explanations, and ambiguous
 * requests stay read-only. The normal PermissionManager still controls every
 * side-effecting tool call.
 */
export const EXECUTION_MODES = Object.freeze(['plan', 'build', 'auto']);

export function isExecutionMode(mode) {
  return EXECUTION_MODES.includes(mode);
}

const READ_ONLY_OVERRIDE = [
  /\b(?:do not|don't|dont|without|no)\s+(?:modify|change|edit|write|delete|remove)\b/i,
  /\b(?:read[ -]only|review only|analysis only|no changes)\b/i,
  /\b(?:jangan|tanpa)\s+(?:mengubah|ubah|edit|modifikasi|menulis|tulis|hapus)\b/i,
  /\b(?:hanya|cuma)\s+(?:review|analisis|baca|jelaskan|periksa)\b/i
];

const EXPLICIT_EXECUTION = [
  /^\s*(?:please\s+)?(?:add|create|write|edit|modify|change|fix|implement|refactor|update|remove|delete|build|generate|integrate|install|configure|run|execute|test|deploy|publish|rename|move|scaffold)\b/i,
  /\b(?:can you|could you|would you|please|i want you to|help me)\s+(?:please\s+)?(?:add|create|write|edit|modify|change|fix|implement|refactor|update|remove|delete|build|generate|integrate|install|configure|run|execute|test|deploy|publish|rename|move|scaffold)\b/i,
  /\b(?:tolong|bantu(?: saya)?|bisa bantu|aku mau|saya mau|gw mau|gue mau|gw pengen|gue pengen|aku ingin|saya ingin|i want to|i'd like to)\s+(?:untuk\s+)?(?:tambah(?:kan|in)?|buat(?:kan)?|bikin|perbaiki|ubah|edit|ganti|hapus|implementasikan|integrasikan|rombak|pasang|jalankan|tes|uji|deploy|rename|pindahkan)\b/i,
  /\b(?:tambah(?:kan|in)?|buat(?:kan)?|bikin|perbaiki|ubah|edit|ganti|hapus|implementasikan|integrasikan|rombak|pasang|jalankan|uji|tes|deploy)\b/i
];

export function resolveAutoMode(requestedMode, content) {
  if (requestedMode !== 'auto') {
    return {
      executionMode: requestedMode === 'plan' ? 'plan' : 'build',
      reason: 'manual_mode'
    };
  }

  const text = String(content || '').trim();
  if (READ_ONLY_OVERRIDE.some(pattern => pattern.test(text))) {
    return { executionMode: 'plan', reason: 'explicit_read_only' };
  }
  if (EXPLICIT_EXECUTION.some(pattern => pattern.test(text))) {
    return { executionMode: 'build', reason: 'explicit_action_request' };
  }
  return { executionMode: 'plan', reason: 'safe_read_only_default' };
}
