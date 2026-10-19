import { api, watchRun } from '../lib/api.js';
import { empty, kv, panel, viewTitle } from '../lib/components.js';
import { fragment, h } from '../lib/dom.js';
import { encoded, formatBytes, formatDuration, isPromptSkill, statusBadge, textBlock } from '../lib/format.js';
import { artifactUrl, hashLink, isImage } from '../lib/links.js';
import { captureLogView, restoreLogView } from '../lib/logs.js';
import { renderViewContent } from '../lib/shell.js';

const itemUrl = (runId, recordId) => `/api/runs/${encoded(runId)}/items/${encoded(recordId)}`;

async function runItemView(runId, recordId) {
  return runItemContent(runId, recordId, await api(itemUrl(runId, recordId)));
}

function runItemContent(runId, recordId, item) {
  const artifactCards = h('div', { className: 'artifact-list' });
  for (const artifact of item.artifacts || []) {
    const url = artifactUrl(runId, recordId, artifact.path);
    const preview = isImage(artifact.path) ? h('img', { src: url, alt: artifact.path, loading: 'lazy' }) : null;
    artifactCards.append(h('div', { className: 'artifact' }, [
      h('div', {}, [
        h('a', { href: url, target: '_blank', rel: 'noreferrer', textContent: artifact.path }),
        h('div', { className: 'muted', textContent: formatBytes(artifact.size) }),
        preview,
      ]),
    ]));
  }
  const artifacts = (item.artifacts || []).length ? artifactCards : empty('No artifacts.');

  // 日志：Live / Stdout / Stderr 一行一个、固定高度、内部滚动，只显示真的有数据的那些。
  // 跑着的 prompt 型 Skill 还没吐一个字时，留一个空的 Live 面板，好让"贴底跟随"有地方发生。
  const active = ['queued', 'running', 'canceling'].includes(item.status);
  const titles = { live: 'Live Logs', stdout: 'Stdout Logs', stderr: 'Stderr Logs' };
  const logRow = h('div', { className: 'log-row' });
  const panels = new Map(); // stream → { text, body, paint }

  // 面板按需建：首屏可能还没有任何日志，流的头一块才决定要不要出现这块面板。
  const addPanel = (stream, text) => {
    const entry = { text, body: h('div', { className: 'panel-body log-panel' }) };
    entry.paint = () => {
      const view = captureLogView(entry.body); // 贴底的继续跟到底，往上翻看历史的不动
      entry.body.replaceChildren(...(entry.text
        ? [textBlock(entry.text)]
        : [h('p', { className: 'panel-note', textContent: 'Waiting for the Skill to print something…' })]));
      restoreLogView(view, entry.body);
    };
    entry.paint();
    panels.set(stream, entry);
    logRow.append(panel(titles[stream], entry.body));
    return entry;
  };

  for (const [stream, text] of Object.entries(titles)) if (item.logs?.[stream]) addPanel(stream, item.logs[stream]);
  if (active && isPromptSkill(item) && !panels.has('live')) addPanel('live', '');
  // 打开就定位到最后一行（首屏这次 paint 时面板还没挂进 DOM，所以放到下一帧）。
  if (panels.size) {
    setTimeout(() => {
      for (const { body } of panels.values()) for (const pre of body.querySelectorAll('pre')) pre.scrollTop = pre.scrollHeight;
    }, 0);
  }

  // Summary 里跟着流一起变的几格
  const statusEl = h('span', {}, statusBadge(item.status));
  const stageEl = h('span', { textContent: item.stage || '—' });
  const durationEl = h('span', { textContent: formatDuration(item.ms) });
  const applyItem = (next) => {
    statusEl.replaceChildren(statusBadge(next.status));
    stageEl.textContent = next.stage || '—';
    durationEl.textContent = formatDuration(next.ms);
  };

  // 跑着才需要订阅（跑完的磁盘上就是全部）——stdout / stderr 型的 Skill 同样要跟，
  // 所以这里只看行是否还活跃，不看它有没有 Live 面板。
  if (active) {
    watchRun(runId, async (event) => {
      const mine = (event.item?.record_id ?? event.record_id) === recordId;
      if (event.type === 'item-log') {
        if (!mine) return;
        const entry = panels.get(event.stream) || addPanel(event.stream, '');
        if (entry.text.endsWith(event.chunk)) return; // 首屏那份来自磁盘，尾部会和流的第一块重叠
        entry.text = `${entry.text}${event.chunk}`.slice(-24000); // 只留尾部：每来一块就整段重画，攒几十万字会拖垮页面
        entry.paint();
        return;
      }
      if (event.type === 'item-stage') {
        if (mine) stageEl.textContent = event.stage || '—';
        return;
      }
      if (event.type === 'item-started') {
        if (mine) applyItem(event.item);
        return;
      }
      if (event.type === 'item-finished' && !mine) return;
      // 这一行跑完 / 整个 Run 收尾：重取一次——流里的正文只是"尾部窗口"，落盘那份才完整，
      // 顺便把 Error 与 Artifacts 一起刷出来。
      if (event.type === 'item-finished' || event.type === 'run-finished' || event.type === 'done') {
        try {
          const fresh = await api(itemUrl(runId, recordId));
          renderViewContent(runItemContent(runId, recordId, fresh), { animate: false });
        } catch {
          // 取不到就保持现状，用户刷新即可。
        }
      }
    });
  }

  return fragment(
    h('div', { className: 'view-head' }, [
      viewTitle(item.record_id || recordId, [
        { label: 'Runs', href: '#runs' },
        { label: runId, href: `#runs/${encoded(runId)}` },
      ]),
    ]),
    panel('Summary', h('div', { className: 'panel-body' }, kv([
      ['Status', statusEl],
      ['Stage', stageEl],
      ['Duration', durationEl],
      // 续跑：这一行没重跑 Skill，而是复用了上一次的产物（见 docs/run.md 的"断点续跑"）。
      ...(item.resumed_from
        ? [['Resumed From', hashLink(item.resumed_from, `#runs/${encoded(item.resumed_from)}`)]]
        : []),
      ['Input Hash', h('span', { className: 'mono', textContent: item.input_hash || '—' })],
    ]))),
    // 错误可能是整段 stderr（含换行与 JSON）：单独一块按日志渲染，别塞进 Summary 的一格里。
    item.error ? panel('Error', h('div', { className: 'panel-body' }, textBlock(item.error))) : null,
    panel(`Artifacts (${(item.artifacts || []).length})`, h('div', { className: 'panel-body' }, artifacts)),
    (panels.size || active) ? logRow : null,
  );
}

export { runItemView };
