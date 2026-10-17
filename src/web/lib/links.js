import { h, icon } from './dom.js';
import { encoded } from './format.js';

function hashLink(label, hash) {
  return h('a', { href: hash, textContent: label });
}

function skillRefFromPath(value) {
  const parts = String(value || '').replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.at(-1) || null;
}

function skillLink(path) {
  if (!path) return '—';
  const ref = skillRefFromPath(path);
  return ref ? hashLink(ref, `#skills/${encoded(ref)}`) : String(path);
}

function templateLink(templateId, label = null) {
  if (!templateId) return '—';
  return hashLink(label || templateId, `#templates/${encoded(templateId)}`);
}

const SUBJECT_META = {
  run: { route: 'runs', label: 'Run', icon: 'runs' },
  template: { route: 'templates', label: 'Template', icon: 'templates' },
  skill: { route: 'skills', label: 'Skill', icon: 'skills' },
};

function subjectLink(subject) {
  if (!subject || !subject.id) return '—';
  const meta = SUBJECT_META[subject.type];
  if (!meta) return String(subject.label || subject.id);
  return h('a', {
    className: 'subject',
    href: `#${meta.route}/${encoded(subject.id)}`,
    title: meta.label,
  }, [
    icon(meta.icon, 'icon subject-icon'),
    h('span', { className: 'mono truncate', textContent: subject.label || subject.id }),
  ]);
}

function larkBaseLink(target = {}) {
  if (!target.base_token) return '—';
  const url = new URL(`https://my.feishu.cn/base/${encodeURIComponent(target.base_token)}`);
  if (target.table_id) url.searchParams.set('table', target.table_id);
  if (target.view_id) url.searchParams.set('view', target.view_id);
  return h('a', {
    className: 'mono',
    href: url.toString(),
    target: '_blank',
    rel: 'noreferrer',
    textContent: url.toString(),
  });
}

function artifactUrl(runId, recordId, relativePath) {
  const parts = String(relativePath).split('/').map(encoded).join('/');
  return `/api/runs/${encoded(runId)}/artifacts/${encoded(recordId)}/${parts}`;
}

function isImage(file) {
  return /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(file);
}

export {
  hashLink,
  skillLink,
  templateLink,
  subjectLink,
  larkBaseLink,
  artifactUrl,
  isImage,
};
