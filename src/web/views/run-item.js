import { api } from '../lib/api.js';
import { empty, kv, panel, viewTitle } from '../lib/components.js';
import { fragment, h } from '../lib/dom.js';
import { encoded, formatBytes, statusBadge, textBlock } from '../lib/format.js';
import { artifactUrl, isImage } from '../lib/links.js';

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
      ['Error', item.error || '—'],
      ['Input Hash', h('span', { className: 'mono', textContent: item.input_hash || '—' })],
    ]))),
    panel(`Artifacts (${(item.artifacts || []).length})`, h('div', { className: 'panel-body' }, artifacts)),
    h('div', { className: 'detail-grid' }, [
      panel('Stdout', h('div', { className: 'panel-body' }, textBlock(item.logs?.stdout))),
      panel('Stderr', h('div', { className: 'panel-body' }, textBlock(item.logs?.stderr))),
    ]),
  );
}

export { runItemView };
