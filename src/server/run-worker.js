import fs from 'node:fs';
import { previewTemplate, runTemplate } from '../core/run-template.js';

function send(message) {
  if (!process.send) return Promise.resolve();
  return new Promise((resolve, reject) => {
    process.send(message, (err) => (err ? reject(err) : resolve()));
  });
}

function readInput() {
  return new Promise((resolve, reject) => {
    let body = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { body += chunk; });
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (err) {
        reject(new Error(`Worker input is not valid JSON: ${err.message}`));
      }
    });
  });
}

async function main() {
  const input = await readInput();
  const template = JSON.parse(fs.readFileSync(input.template_path, 'utf8'));

  if (input.type === 'preview') {
    await send({ type: 'preview', data: previewTemplate(template, input.options || {}) });
    process.exit(0);
    return;
  }
  if (input.type !== 'run') throw new Error(`Unsupported worker task: ${input.type}`);

  await runTemplate({
    template,
    options: input.options || {},
    runId: input.run_id,
    runDir: input.run_dir,
    templateName: input.template_name || null,
    onEvent: send,
  });
  process.disconnect?.();
}

process.on('disconnect', () => process.exit(1));

main().catch(async (err) => {
  try {
    await send({ type: 'error', error: { message: err.message, stack: err.stack || null } });
  } catch {
    // Parent already exited.
  }
  process.disconnect?.();
  process.exit(1);
});
