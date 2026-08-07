/**
 * Provider: the Claude CLI installed on this machine.
 *
 * The zero-config default — it reuses whatever credentials `claude` already
 * has, so there is no API key to store anywhere.
 */

const { spawn } = require('node:child_process');
const { SYSTEM_PROMPT } = require('../prompt');

const TIMEOUT_MS = 180000;

function complete({ prompt, model, cwd, timeoutMs = TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'json', '--append-system-prompt', SYSTEM_PROMPT];
    if (model) args.push('--model', model);

    // shell:true so Windows resolves the `claude` shim (claude.cmd) on PATH.
    const child = spawn('claude', args, { cwd, shell: process.platform === 'win32' });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Claude CLI timed out after ${timeoutMs / 1000}s.`));
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Could not launch Claude CLI: ${err.message}. Is \`claude\` on your PATH?`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`Claude CLI exited ${code}: ${stderr.trim() || '(no stderr)'}`));
      }
      try {
        // --output-format json wraps the reply; `result` holds the text.
        const envelope = JSON.parse(stdout);
        resolve({ text: envelope.result ?? stdout, cost: envelope.total_cost_usd });
      } catch {
        resolve({ text: stdout }); // tolerate a bare-text reply
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

module.exports = {
  id: 'cli',
  label: 'Claude CLI',
  needsKey: false,
  complete,
};
