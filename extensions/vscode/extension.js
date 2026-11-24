const vscode = require('vscode');
const http = require('http');

function getConfig() {
  const config = vscode.workspace.getConfiguration('nexus');
  return {
    serverUrl: config.get('serverUrl', 'http://127.0.0.1:3000'),
    token: config.get('token', '')
  };
}

async function sendToNexus(prompt) {
  const { serverUrl, token } = getConfig();
  const outputChannel = vscode.window.createOutputChannel('Nexus Agent');
  outputChannel.show(true);
  outputChannel.appendLine(`> ${prompt}\n`);

  try {
    // Create session
    const session = await httpJson(`${serverUrl}/session`, 'POST', { mode: 'plan' }, token);
    const sessionId = session.id;

    // Send message
    await httpJson(`${serverUrl}/session/${sessionId}/message`, 'POST', { content: prompt }, token);

    // Poll for completion via loading session (simple approach)
    // In production, use SSE stream
    await new Promise(r => setTimeout(r, 3000));
    const loaded = await httpJson(`${serverUrl}/session/${sessionId}`, 'GET', null, token);

    const lastAssistant = loaded.messages?.filter(m => m.role === 'assistant').pop();
    if (lastAssistant?.content) {
      outputChannel.appendLine(lastAssistant.content);
    } else {
      outputChannel.appendLine('(No response from agent)');
    }
  } catch (err) {
    outputChannel.appendLine(`Error: ${err.message}`);
    vscode.window.showErrorMessage(`Nexus: ${err.message}`);
  }
}

function httpJson(url, method, body, token) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    if (token) options.headers['Authorization'] = `Bearer ${token}`;

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Invalid JSON: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('nexus.sendPrompt', async () => {
      const prompt = await vscode.window.showInputBox({ prompt: 'Enter prompt for Nexus agent' });
      if (prompt) await sendToNexus(prompt);
    }),

    vscode.commands.registerCommand('nexus.reviewSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('No active editor');
        return;
      }
      const selection = editor.document.getText(editor.selection);
      if (!selection) {
        vscode.window.showWarningMessage('No text selected');
        return;
      }
      const file = editor.document.fileName;
      await sendToNexus(`Review this code from ${file}:\n\`\`\`\n${selection}\n\`\`\``);
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
