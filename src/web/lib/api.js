import { setNotice } from './dom.js';
import { encoded } from './format.js';

let activeStream = null;

function stopRunStream() {
  if (activeStream) activeStream.abort();
  activeStream = null;
}

async function api(path, options = {}) {
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers: {
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
    body,
    credentials: 'same-origin',
    cache: 'no-store',
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // The error below includes the HTTP status.
  }
  if (!response.ok || !payload?.ok) {
    const error = payload?.error;
    const message = error?.message || `Request failed (${response.status})`;
    throw new Error(error?.action ? `${message}. ${error.action}` : message);
  }
  return payload.data;
}

/** 读取 SSE 帧；`data:` 行拼回 JSON 后逐条交给 onEvent。 */
async function readEventStream(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let closed = false;
  while (!closed) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame.split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))
        .join('\n');
      if (!data) continue;
      closed = onEvent(JSON.parse(data)) === 'stop';
      if (closed) break;
    }
  }
}

async function watchRun(runId, onEvent) {
  stopRunStream();
  const controller = new AbortController();
  activeStream = controller;
  try {
    const response = await fetch(`/api/runs/${encoded(runId)}/events`, {
      headers: { accept: 'text/event-stream' },
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error(`Event stream failed (${response.status})`);
    await readEventStream(response, (event) => {
      onEvent(event);
      return event.type === 'done' ? 'stop' : 'continue';
    });
    controller.abort();
  } catch (error) {
    if (error.name !== 'AbortError') setNotice(error.message, true);
  } finally {
    if (activeStream === controller) activeStream = null;
  }
}

/**
 * 订阅一条持久化操作，直到它终结；resolve 它的 result。
 * 页面刷新后靠 operation_id 重新挂上同一条流。
 */
function watchOperation(ref, operationId, onEvent = () => {}) {
  const controller = new AbortController();
  activeStream = controller;
  const query = operationId ? `?operation_id=${encoded(operationId)}` : '';
  return new Promise(async (resolve, reject) => {
    try {
      const response = await fetch(`/api/skills/${encoded(ref)}/events${query}`, {
        headers: { accept: 'text/event-stream' },
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error(`Operation stream failed (${response.status})`);
      await readEventStream(response, (event) => {
        onEvent(event);
        if (event.error) {
          throw new Error(event.error.action ? `${event.error.message}. ${event.error.action}` : event.error.message);
        }
        if (event.type === 'done') {
          resolve((event.operation || event.job).result);
          return 'stop';
        }
        const operation = event.operation || event.job;
        if (operation && ['completed', 'failed', 'canceled', 'interrupted'].includes(operation.status)) {
          if (operation.status !== 'completed') {
            const message = operation.error?.message || `Operation ${operation.status}`;
            const action = operation.error?.action ? `. ${operation.error.action}` : '';
            throw new Error(`${message}${action}`);
          }
          resolve(operation.result);
          return 'stop';
        }
        return 'continue';
      });
      controller.abort();
      throw new Error('Operation stream ended before it finished');
    } catch (error) {
      if (error.name === 'AbortError') return;
      reject(error);
    }
  });
}

async function startOperation(path, body, method = 'POST') {
  const operation = await api(path, { method, body });
  notifyTaskStarted();
  const ref = operation.input?.ref || body.ref;
  return watchOperation(ref, operation.operation_id);
}

/** 有新消息了：让侧边栏消息区立刻刷新，不用等下一次轮询。 */
function notifyTaskStarted() {
  window.dispatchEvent(new CustomEvent('skillapp:message'));
}

export { api, watchRun, watchOperation, startOperation, stopRunStream, notifyTaskStarted };
