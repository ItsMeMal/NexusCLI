import fs from 'node:fs';
import path from 'node:path';

/**
 * Export a session object to a self-contained HTML file.
 * @param {object} session - Session object with .messages, .id, .model, etc.
 * @param {string} outputPath - File path for the HTML output.
 */
export function exportSessionToHTML(session, outputPath) {
  const messages = session.messages || [];
  const title = `Nexus Session ${session.id}`;
  const dateStr = new Date(session.createdAt || Date.now()).toLocaleString();

  const renderMessage = (msg) => {
    const role = msg.role || 'unknown';
    const content = escapeHtml(formatContent(msg));
    const toolCalls = msg.tool_calls
      ? msg.tool_calls.map(tc => {
          const fn = tc.function || {};
          return `<div class="tool-call"><strong>⚙️ ${escapeHtml(fn.name || 'unknown')}</strong><pre>${escapeHtml(fn.arguments || '')}</pre></div>`;
        }).join('')
      : '';
    return `<div class="msg ${role}"><div class="role">${roleLabel(role)}</div><div class="content"><pre>${content}</pre>${toolCalls}</div></div>`;
  };

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0d1117;color:#c9d1d9;padding:20px;max-width:900px;margin:0 auto}
h1{color:#58a6ff;margin-bottom:4px;font-size:1.4em}
.meta{color:#8b949e;font-size:.85em;margin-bottom:24px;border-bottom:1px solid #21262d;padding-bottom:12px}
.msg{margin-bottom:16px;border-radius:8px;padding:12px 16px;border:1px solid #21262d}
.msg.user{background:#161b22;border-left:3px solid #58a6ff}
.msg.assistant{background:#0d1117;border-left:3px solid #3fb950}
.msg.system{background:#161b22;border-left:3px solid #8b949e;font-size:.9em}
.msg.tool{background:#161b22;border-left:3px solid #d29922;font-size:.9em}
.role{font-weight:700;font-size:.8em;text-transform:uppercase;margin-bottom:6px;letter-spacing:.05em}
.user .role{color:#58a6ff}
.assistant .role{color:#3fb950}
.system .role{color:#8b949e}
.tool .role{color:#d29922}
.content pre{white-space:pre-wrap;word-break:break-word;font-family:'SF Mono',Consolas,monospace;font-size:.9em;line-height:1.5}
.tool-call{margin-top:8px;padding:8px;background:#21262d;border-radius:4px}
.tool-call strong{color:#d29922}
.tool-call pre{font-size:.82em;margin-top:4px;color:#8b949e}
footer{margin-top:32px;text-align:center;color:#484f58;font-size:.8em;border-top:1px solid #21262d;padding-top:12px}
</style>
</head>
<body>
<h1>🤖 ${escapeHtml(title)}</h1>
<div class="meta">Model: ${escapeHtml(session.model || 'unknown')} · Mode: ${escapeHtml(session.mode || 'build')} · Created: ${escapeHtml(dateStr)} · Messages: ${messages.length}</div>
${messages.map(renderMessage).join('\n')}
<footer>Exported by Nexus Coding Agent CLI · ${escapeHtml(new Date().toISOString())}</footer>
</body>
</html>`;

  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, html, 'utf8');
  return outputPath;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function roleLabel(role) {
  const labels = { user: '👤 User', assistant: '🤖 Assistant', system: '⚙️ System', tool: '🔧 Tool' };
  return labels[role] || role;
}

function formatContent(msg) {
  if (typeof msg.content === 'string') return msg.content;
  if (msg.content === null && msg.tool_calls) return '(tool calls)';
  if (msg.content === null) return '';
  return JSON.stringify(msg.content, null, 2);
}
