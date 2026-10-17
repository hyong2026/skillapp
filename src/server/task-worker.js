import { loadSkill } from '../core/load-skill.js';
import { analyzeSkill } from '../core/analyze-skill.js';
import { planMapping, applyMapping } from '../core/bind-table.js';
import { planUnload, applyUnload } from '../core/unload-skill.js';
import { deleteRun } from '../core/delete-run.js';
import { setTemplateArchived } from '../core/template.js';

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

async function execute(input) {
  const payload = input.input || {};
  if (input.type === 'load-skill') {
    return loadSkill({ sourcePath: payload.source_path });
  }
  if (input.type === 'analyze-skill') {
    return analyzeSkill({
      ref: payload.ref,
      onProgress: (progress) => send({ type: 'operation-progress', progress }),
    });
  }
  if (input.type === 'bind-table') {
    const plan = planMapping(payload);
    return applyMapping({ ...payload, planHash: plan.plan_hash }, plan);
  }
  if (input.type === 'unload-skill') {
    return applyUnload(payload, planUnload(payload));
  }
  if (input.type === 'delete-run') {
    return deleteRun({ runId: payload.run_id });
  }
  if (input.type === 'archive-template' || input.type === 'unarchive-template') {
    return setTemplateArchived({
      templateId: payload.template_id,
      archived: input.type === 'archive-template',
    });
  }
  throw new Error(`Unsupported task: ${input.type}`);
}

async function main() {
  const input = await readInput();
  await send({ type: 'operation-started' });
  const result = await execute(input);
  await send({ type: 'operation-result', result });
  process.disconnect?.();
  process.exit(0);
}

process.on('disconnect', () => process.exit(1));

main().catch(async (err) => {
  try {
    await send({
      type: 'error',
      error: {
        code: err.code || 'TASK_FAILED',
        message: err.message || 'Task failed',
        action: err.action || null,
        status: err.status || 500,
        stack: err.stack || null,
      },
    });
  } catch {
    // Parent already exited.
  }
  process.disconnect?.();
  process.exit(1);
});
