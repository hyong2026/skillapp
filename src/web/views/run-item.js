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
  const running = ['queued', 'running', 'canceling'].includes(item.status);
  const logRow = h('div', { className: 'log-row' });
  const panels = new Map(); // stream → { text, body, paint }
  const wanted = [
    ['live', 'Live Logs', item.logs?.live],
    ['stdout', 'Stdout Logs', item.logs?.stdout],
    ['stderr', 'Stderr Logs', item.logs?.stderr],
  ].filter(([, , text]) => text);
  if (running && isPromptSkill(item) && !wanted.some(([stream]) => stream === 'live')) wanted.unshift(['live', 'Live Logs', '']);

  for (const [stream, title, text] of wanted) {
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
    logRow.append(panel(title, entry.body));
  }
  // 打开就定位到最后一行（首屏这次 paint 时面板还没挂进 DOM，所以放到下一帧）。
  if (wanted.length) {
    setTimeout(() => {
      for (const { body } of panels.values()) for (const pre of body.querySelectorAll('pre')) pre.scrollTop = pre.scrollHeight;
    }, 0);
  }
  // 跑着的 Live 才需要订阅；跑完的磁盘上就是全部。
  const livePanel = panels.get('live');
  if (livePanel && running) {
    watchRun(runId, async (event) => {
      if (event.type === 'done') {
        // 跑到终态：重新取一次。流的这段正文是"尾部窗口"（长跑时丢开头），
        // 落盘的那份才是完整的；顺便把 Summary 里的状态也刷成终态。
        try {
          const fresh = await api(itemUrl(runId, recordId));
          renderViewContent(runItemContent(runId, recordId, fresh), { animate: false });
        } catch {
          // 取不到就保持现状，用户刷新即可。
        }
        return;
      }
      if (event.type !== 'item-log' || event.record_id !== recordId || event.stream !== 'live') return;
      if (livePanel.text.endsWith(event.chunk)) return;
      livePanel.text = `${livePanel.text}${event.chunk}`.slice(-24000); // 只留尾部：每来一块就整段重画，攒几十万字会拖垮页面
      livePanel.paint();
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
      ['Status', statusBadge(item.status)],
      ['Stage', item.stage || '—'],
      ['Duration', formatDuration(item.ms)],
      // 续跑：这一行没重跑 Skill，而是复用了上一次的产物（见 docs/run.md 的"断点续跑"）。
      ...(item.resumed_from
        ? [['Resumed From', hashLink(item.resumed_from, `#runs/${encoded(item.resumed_from)}`)]]
        : []),
      ['Input Hash', h('span', { className: 'mono', textContent: item.input_hash || '—' })],
    ]))),
    // 错误可能是整段 stderr（含换行与 JSON）：单独一块按日志渲染，别塞进 Summary 的一格里。
    item.error ? panel('Error', h('div', { className: 'panel-body' }, textBlock(item.error))) : null,
    panel(`Artifacts (${(item.artifacts || []).length})`, h('div', { className: 'panel-body' }, artifacts)),
    wanted.length ? logRow : null,
  );
}

export { runItemView };
