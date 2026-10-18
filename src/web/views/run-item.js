import { api, watchRun } from '../lib/api.js';
import { empty, kv, panel, viewTitle } from '../lib/components.js';
import { fragment, h } from '../lib/dom.js';
import { encoded, formatBytes, isPromptSkill, statusBadge, textBlock } from '../lib/format.js';
import { artifactUrl, isImage } from '../lib/links.js';
import { captureLogView, restoreLogView } from '../lib/logs.js';

async function runItemView(runId, recordId) {
  const item = await api(`/api/runs/${encoded(runId)}/items/${encoded(recordId)}`);
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

  // 两套日志：prompt 型 Skill 看实时的 Live Log（每次追加，贴底才跟随）；
  // 脚本型的 stdout / stderr 是跑完那一刻才完整的，所以只在终态整段给。
  const logPanels = [];
  if (isPromptSkill(item)) {
    let text = item.logs?.live || '';
    const body = h('div', { className: 'panel-body live-logs' });
    const paint = () => {
      // 重画前记下滚动状态：贴底的继续跟到底，往上翻看历史的不动。
      const view = captureLogView();
      body.replaceChildren(...(text
        ? [h('section', { className: 'live-log' }, [h('h3', { textContent: 'live' }), textBlock(text)])]
        : [h('p', { className: 'panel-note', textContent: 'Waiting for the Skill to print something…' })]));
      restoreLogView(view);
    };
    paint();
    logPanels.push(panel('Live Log', body));
    // 首屏那次 paint 时面板还没挂进 DOM（capture/restore 都取不到节点），挂上去后再滚到底。
    setTimeout(() => { for (const pre of body.querySelectorAll('pre')) pre.scrollTop = pre.scrollHeight; }, 0);
    // 已经跑完的就不用再订阅了：磁盘上的日志就是全部。
    if (['queued', 'running', 'canceling'].includes(item.status)) {
      watchRun(runId, (event) => {
        if (event.type !== 'item-log' || event.record_id !== recordId || event.stream !== 'live') return;
        if (text.endsWith(event.chunk)) return;
        text = `${text}${event.chunk}`.slice(-24000);
        paint();
      });
    }
  } else if (!['queued', 'running', 'canceling'].includes(item.status)) {
    logPanels.push(h('div', { className: 'detail-grid' }, [
      panel('Stdout Logs', h('div', { className: 'panel-body' }, textBlock(item.logs?.stdout))),
      panel('Stderr Logs', h('div', { className: 'panel-body' }, textBlock(item.logs?.stderr))),
    ]));
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
      ['Duration', item.ms === null || item.ms === undefined ? '—' : `${item.ms} ms`],
      ['Input Hash', h('span', { className: 'mono', textContent: item.input_hash || '—' })],
    ]))),
    // 错误可能是整段 stderr（含换行与 JSON）：单独一块按日志渲染，别塞进 Summary 的一格里。
    item.error ? panel('Error', h('div', { className: 'panel-body' }, textBlock(item.error))) : null,
    panel(`Artifacts (${(item.artifacts || []).length})`, h('div', { className: 'panel-body' }, artifacts)),
    ...logPanels,
  );
}

export { runItemView };
