'use strict';

(() => {
  const app = document.getElementById('app');
  const notice = document.getElementById('notice');
  let renderSequence = 0;

  function h(tag, attrs = {}, children = []) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'className') el.className = value;
      else if (key === 'textContent') el.textContent = value;
      else if (key === 'onClick') el.addEventListener('click', value);
      else if (value === true) el.setAttribute(key, '');
      else el.setAttribute(key, String(value));
    }
    for (const child of Array.isArray(children) ? children : [children]) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  function fragment(...children) {
    const el = document.createDocumentFragment();
    for (const child of children) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  function setNotice(message = '', isError = false) {
    notice.textContent = message;
    notice.className = `notice${message ? ' visible' : ''}${isError ? ' error' : ''}`;
  }

  async function api(path) {
    const response = await fetch(path, {
      headers: { accept: 'application/json' },
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

  function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    const pad = (part) => String(part).padStart(2, '0');
    return [
      `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
      `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
    ].join(' ');
  }

  function formatBytes(value) {
    if (!Number.isFinite(value)) return '—';
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }

  const STATUS_LABELS = {
    succeeded: 'Succeeded',
    completed: 'Completed',
    valid: 'Valid',
    failed: 'Failed',
    partial: 'Partial',
    canceled: 'Canceled',
    interrupted: 'Interrupted',
    running: 'Running',
    queued: 'Queued',
    'dry-run': 'Dry run',
  };

  function statusBadge(status) {
    const safe = String(status || 'unknown').toLowerCase();
    const known = Object.keys(STATUS_LABELS);
    return h('span', {
      className: `badge ${known.includes(safe) ? safe : 'unknown'}`,
      textContent: STATUS_LABELS[safe] || safe,
    });
  }

  function markdownBlock(value) {
    if (value === null || value === undefined || value === '') {
      return h('p', { className: 'muted', textContent: 'Not recorded' });
    }
    const article = h('article', { className: 'markdown' });
    article.innerHTML = window.SkillAppMarkdown.renderMarkdown(value);
    return article;
  }

  function codeBlock(value) {
    if (value === null || value === undefined) return h('span', { className: 'muted', textContent: 'Not recorded' });
    const code = h('code');
    code.innerHTML = window.SkillAppMarkdown.highlightJson(value);
    return h('pre', { className: 'code-block' }, code);
  }

  function textBlock(value) {
    if (value === null || value === undefined || value === '') {
      return h('span', { className: 'muted', textContent: 'Not recorded' });
    }
    return h('pre', { className: 'code-block' }, h('code', { textContent: String(value) }));
  }

  function kv(entries) {
    const list = h('dl', { className: 'kv' });
    for (const [key, value] of entries) {
      list.append(h('dt', { textContent: key }), h('dd', {}, value instanceof Node ? value : String(value ?? '—')));
    }
    return list;
  }

  function panel(title, body, actions = null) {
    const header = title || actions
      ? h('div', { className: 'panel-head' }, [
        title ? h('h2', { textContent: title }) : h('span'),
        actions,
      ])
      : null;
    return h('section', { className: 'panel' }, [
      header,
      body,
    ]);
  }

  function togglePanel(title, codeLabel, renderUI, renderCode) {
    const body = h('div', { className: 'panel-body toggle-body' });
    let showCode = false;
    const control = h('button', {
      className: 'code-toggle',
      type: 'button',
      role: 'switch',
      'aria-checked': 'false',
      'aria-label': `Show ${codeLabel}`,
      onClick: () => {
        showCode = !showCode;
        control.classList.toggle('active', showCode);
        control.setAttribute('aria-checked', String(showCode));
        control.setAttribute('aria-label', `${showCode ? 'Hide' : 'Show'} ${codeLabel}`);
        body.replaceChildren(showCode ? renderCode() : renderUI());
      },
    }, [
      h('span', { textContent: codeLabel }),
      h('span', { className: 'toggle-track', 'aria-hidden': 'true' }, h('span', { className: 'toggle-thumb' })),
    ]);
    body.replaceChildren(renderUI());
    return panel(title, body, control);
  }

  function ioContractPanel(schema) {
    const inputs = Array.isArray(schema?.inputs) ? schema.inputs : [];
    const outputs = Array.isArray(schema?.outputs) ? schema.outputs : [];
    return togglePanel('IO Contract', 'JSON', () => h('div', { className: 'contract-body' }, [
      section(`Inputs (${inputs.length})`, dataTable(
        ['Column', 'Key', 'Type', 'Required', 'Default', 'Constraints / Notes'],
        inputRows(inputs),
        'Input fields',
      )),
      section(`Outputs (${outputs.length})`, dataTable(
        ['Column', 'Key', 'Type', 'Value path', 'Precision'],
        outputRows(outputs),
        'Output fields',
      )),
    ]), () => codeBlock(schema));
  }

  function mappingPanel(template) {
    const inputs = Array.isArray(template?.mapping?.inputs) ? template.mapping.inputs : [];
    const outputs = Array.isArray(template?.mapping?.outputs) ? template.mapping.outputs : [];
    return togglePanel('Mapping', 'JSON', () => h('div', { className: 'contract-body' }, [
      section(`Inputs (${inputs.length})`, dataTable(
        ['Key', 'field_id', 'Type', 'Required', 'Default', 'Rules'],
        mappingInputRows(inputs),
        'Template input mapping',
      )),
      section(`Outputs (${outputs.length})`, dataTable(
        ['Key', 'field_id', 'Type', 'Value path', 'Precision'],
        mappingOutputRows(outputs),
        'Template output mapping',
      )),
    ]), () => codeBlock(template.mapping));
  }

  function dataPanel(body) {
    return panel(null, body);
  }

  function head(title, description = '') {
    return h('div', { className: 'view-head' }, [
      h('div', {}, [
        h('h1', { textContent: title }),
        description ? h('p', { className: 'muted', textContent: description }) : null,
      ]),
    ]);
  }

  function empty(message) {
    return h('div', { className: 'empty', textContent: message });
  }

  function dataTable(headers, rows, label = 'Data table') {
    const table = h('table');
    const thead = h('thead');
    const headerRow = h('tr');
    for (const header of headers) headerRow.append(h('th', { scope: 'col', textContent: header }));
    thead.append(headerRow);
    const tbody = h('tbody');
    if (!rows.length) {
      const td = h('td', { colSpan: headers.length });
      td.append(empty('No data'));
      tbody.append(h('tr', {}, td));
    } else {
      for (const cells of rows) {
        const tr = h('tr');
        for (const cell of cells) tr.append(h('td', {}, cell instanceof Node ? cell : String(cell ?? '—')));
        tbody.append(tr);
      }
    }
    table.append(thead, tbody);
    const wrap = h('div', { className: 'table-wrap', role: 'region', tabindex: '0', 'aria-label': label });
    wrap.append(table);
    return wrap;
  }

  function section(title, content) {
    return h('section', { className: 'contract-section' }, [
      h('h3', { textContent: title }),
      content,
    ]);
  }

  function formatMeta(value) {
    if (value === undefined || value === null || value === '') return '—';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  function specMeta(spec) {
    const parts = [];
    if (spec.validate) {
      parts.push(Object.entries(spec.validate).map(([key, value]) => `${key}=${formatMeta(value)}`).join(' · '));
    }
    if (spec.transform) parts.push(`transform=${JSON.stringify(spec.transform)}`);
    if (spec.hint) parts.push(spec.hint);
    return parts.join(' · ') || '—';
  }

  function inputRows(specs) {
    return specs.map((spec) => [
      spec.label || spec.key,
      h('span', { className: 'mono', textContent: spec.key || '—' }),
      h('span', { className: 'mono', textContent: spec.type || '—' }),
      spec.required ? 'Yes' : 'No',
      formatMeta(spec.default),
      specMeta(spec),
    ]);
  }

  function outputRows(specs) {
    return specs.map((spec) => [
      spec.label || spec.key,
      h('span', { className: 'mono', textContent: spec.key || '—' }),
      h('span', { className: 'mono', textContent: spec.type || '—' }),
      h('span', { className: 'mono', textContent: spec.from || '—' }),
      spec.round === undefined ? '—' : spec.round,
    ]);
  }

  function mappingInputRows(entries) {
    return entries.map((entry) => [
      entry.key,
      h('span', { className: 'mono', textContent: entry.field_id || '—' }),
      h('span', { className: 'mono', textContent: entry.type || '—' }),
      entry.required ? 'Yes' : 'No',
      formatMeta(entry.default),
      specMeta(entry),
    ]);
  }

  function mappingOutputRows(entries) {
    return entries.map((entry) => [
      entry.key,
      h('span', { className: 'mono', textContent: entry.field_id || '—' }),
      h('span', { className: 'mono', textContent: entry.type || '—' }),
      h('span', { className: 'mono', textContent: entry.from || '—' }),
      entry.round === undefined ? '—' : entry.round,
    ]);
  }

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
    return ref ? hashLink(path, `#skills/${encoded(ref)}`) : String(path);
  }

  function templateLink(templateId) {
    if (!templateId) return '—';
    return hashLink(templateId, `#templates/${encoded(templateId)}`);
  }

  function encoded(value) {
    return encodeURIComponent(String(value));
  }

  function artifactUrl(runId, recordId, relativePath) {
    const parts = String(relativePath).split('/').map(encoded).join('/');
    return `/api/runs/${encoded(runId)}/artifacts/${encoded(recordId)}/${parts}`;
  }

  function isImage(file) {
    return /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(file);
  }

  async function skillsView() {
    const skills = await api('/api/skills');
    const rows = skills.map((skill) => [
      hashLink(skill.ref, `#skills/${encoded(skill.ref)}`),
      statusBadge(skill.valid ? 'valid' : 'failed'),
      h('span', { textContent: formatDate(skill.loaded_at) }),
      h('span', { className: 'truncate', textContent: skill.source || '—' }),
    ]);
    return fragment(
      head('Skills'),
      dataPanel(h('div', { className: 'panel-body flush' }, dataTable(
        ['Ref', 'Status', 'Loaded', 'Source'],
        rows,
      ))),
    );
  }

  async function skillView(ref) {
    const skill = await api(`/api/skills/${encoded(ref)}`);
    const analysis = skill.analysis || {};
    const schema = analysis.schema || null;
    const summary = panel('Skill', h('div', { className: 'panel-body' }, kv([
      ['Ref', skill.ref],
      ['Status', statusBadge(skill.valid ? 'valid' : 'failed')],
      ['Fingerprint', h('span', { className: 'mono', textContent: skill.hash || '—' })],
      ['Loaded', formatDate(skill.loaded_at)],
      ['Source', skill.source || '—'],
    ])));
    const contract = schema
      ? ioContractPanel(schema)
      : panel('IO Contract', h('div', { className: 'panel-body' }, empty('No IO contract available.')));
    const report = togglePanel(
      'Analysis Report',
      'Markdown',
      () => markdownBlock(analysis.report),
      () => textBlock(analysis.report),
    );
    return fragment(
      h('div', { className: 'view-head' }, [
        h('div', {}, [
          h('h1', { textContent: skill.ref }),
          h('p', { className: 'back-link' }, hashLink('Back to Skills', '#skills')),
        ]),
      ]),
      summary,
      contract,
      report,
    );
  }

  async function templatesView() {
    const templates = await api('/api/templates');
    const rows = templates.map((template) => {
      const last = template.last_run;
      const id = template.template_id || template.ref;
      return [
        hashLink(template.ref, `#templates/${encoded(id)}`),
        h('span', { className: 'mono truncate', textContent: template.template_id || '—' }),
        h('span', { textContent: template.target?.table_id || '—' }),
        `${template.inputs} in / ${template.outputs} out`,
        last ? statusBadge(last.status) : h('span', { className: 'muted', textContent: 'Never' }),
        h('span', { textContent: formatDate(template.created_at) }),
      ];
    });
    return fragment(
      head('Templates'),
      dataPanel(h('div', { className: 'panel-body flush' }, dataTable(
        ['Ref', 'Template ID', 'Table ID', 'IO', 'Last run', 'Created'],
        rows,
      ))),
    );
  }

  async function templateView(id) {
    const data = await api(`/api/templates/${encoded(id)}`);
    const template = data.template;
    const target = template.target || {};
    const skill = template.skill || {};
    return fragment(
      h('div', { className: 'view-head' }, [
        h('div', {}, [
          h('h1', { textContent: data.ref }),
          h('p', { className: 'back-link' }, hashLink('Back to Templates', '#templates')),
        ]),
      ]),
      panel('Summary', h('div', { className: 'panel-body' }, kv([
        ['Template ID', h('span', { className: 'mono', textContent: template.template_id || '—' })],
        ['Skill', skillLink(skill.path)],
        ['Skill hash', h('span', { className: 'mono', textContent: skill.hash || '—' })],
        ['Base token', target.base_token || '—'],
        ['Table ID', target.table_id || '—'],
        ['View ID', target.view_id || '—'],
        ['Created', formatDate(template.created_at)],
      ]))),
      mappingPanel(template),
    );
  }

  async function runsView() {
    const runs = await api('/api/runs');
    const rows = runs.map((run) => [
      hashLink(run.run_id, `#runs/${encoded(run.run_id)}`),
      statusBadge(run.status),
      h('span', { className: 'mono truncate' }, templateLink(run.template_id)),
      run.trigger || '—',
      `${run.succeeded} / ${run.total}`,
      run.failed ? h('span', { className: 'mono', textContent: String(run.failed) }) : '0',
      h('span', { textContent: formatDate(run.started_at) }),
    ]);
    return fragment(
      head('Runs'),
      dataPanel(h('div', { className: 'panel-body flush' }, dataTable(
        ['Run ID', 'Status', 'Template ID', 'Trigger', 'Succeeded / Total', 'Failed', 'Started'],
        rows,
      ))),
    );
  }

  async function runView(runId) {
    const run = await api(`/api/runs/${encoded(runId)}`);
    const items = Array.isArray(run.items) ? run.items : [];
    const rows = items.map((item) => [
      hashLink(item.record_id, `#runs/${encoded(runId)}/${encoded(item.record_id)}`),
      statusBadge(item.status),
      item.stage || '—',
      item.ms === null || item.ms === undefined ? '—' : `${item.ms} ms`,
      item.error || '—',
    ]);
    return fragment(
      h('div', { className: 'view-head' }, [
        h('div', {}, [
          h('h1', { textContent: run.run_id || runId }),
          h('p', { className: 'back-link' }, hashLink('Back to Runs', '#runs')),
        ]),
      ]),
      panel('Summary', h('div', { className: 'panel-body' }, kv([
        ['Status', statusBadge(run.status)],
        ['Template ID', h('span', { className: 'mono' }, templateLink(run.template_id))],
        ['Trigger', run.trigger || '—'],
        ['Started', formatDate(run.started_at)],
        ['Finished', formatDate(run.finished_at)],
        ['Succeeded / Failed', `${run.succeeded ?? '—'} / ${run.failed ?? '—'}`],
        ['Work hash', h('span', { className: 'mono', textContent: run.work_hash || '—' })],
      ]))),
      panel('RunItem', h('div', { className: 'panel-body flush' }, dataTable(
        ['Record ID', 'Status', 'Stage', 'Duration', 'Error'],
        rows,
      ))),
    );
  }

  async function runItemView(runId, recordId) {
    const item = await api(`/api/runs/${encoded(runId)}/items/${encoded(recordId)}`);
    const artifacts = h('div', { className: 'artifact-list' });
    for (const artifact of item.artifacts || []) {
      const url = artifactUrl(runId, recordId, artifact.path);
      const preview = isImage(artifact.path) ? h('img', { src: url, alt: artifact.path, loading: 'lazy' }) : null;
      artifacts.append(h('div', { className: 'artifact' }, [
        h('div', {}, [
          h('a', { href: url, target: '_blank', rel: 'noreferrer', textContent: artifact.path }),
          h('div', { className: 'muted', textContent: formatBytes(artifact.size) }),
          preview,
        ]),
        h('a', { className: 'button primary', href: url, download: true, textContent: 'Download' }),
      ]));
    }
    if (!(item.artifacts || []).length) artifacts.append(empty('No artifacts.'));

    return fragment(
      h('div', { className: 'view-head' }, [
        h('div', {}, [
          h('h1', { textContent: item.record_id || recordId }),
          h('p', { className: 'back-link' }, hashLink('Back to Run', `#runs/${encoded(runId)}`)),
        ]),
      ]),
      panel('Status', h('div', { className: 'panel-body' }, kv([
        ['Status', statusBadge(item.status)],
        ['Stage', item.stage || '—'],
        ['Duration', item.ms === null || item.ms === undefined ? '—' : `${item.ms} ms`],
        ['Error', item.error || '—'],
        ['Input hash', h('span', { className: 'mono', textContent: item.input_hash || '—' })],
      ]))),
      panel(`Artifacts (${(item.artifacts || []).length})`, h('div', { className: 'panel-body' }, artifacts)),
      h('div', { className: 'detail-grid' }, [
        panel('stdout', h('div', { className: 'panel-body' }, codeBlock(item.logs?.stdout))),
        panel('stderr', h('div', { className: 'panel-body' }, codeBlock(item.logs?.stderr))),
      ]),
    );
  }

  function loadingView() {
    return h('div', { className: 'skeleton-page', 'aria-hidden': 'true' }, [
      h('div', { className: 'skeleton skeleton-title' }),
      h('div', { className: 'skeleton skeleton-subtitle' }),
      h('div', { className: 'skeleton skeleton-panel' }),
    ]);
  }

  function errorView(error) {
    return h('div', { className: 'error-box' }, [
      h('strong', { textContent: 'Failed to load' }),
      h('p', { textContent: error.message }),
      h('div', { className: 'error-actions' }, [
        h('button', { className: 'button primary', type: 'button', textContent: 'Retry', onClick: render }),
      ]),
    ]);
  }

  function setActive(route) {
    for (const link of document.querySelectorAll('[data-route]')) {
      const active = link.dataset.route === route;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
  }

  async function render() {
    const sequence = ++renderSequence;
    const rawHash = (location.hash || '#skills').slice(1);
    let parts;
    try {
      parts = rawHash.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
    } catch {
      parts = ['skills'];
    }
    const route = parts[0] === 'home' || parts[0] === 'status' || !parts[0] ? 'skills' : parts[0];
    setActive(route);
    setNotice('');
    app.setAttribute('aria-busy', 'true');
    app.replaceChildren(loadingView());

    try {
      let content;
      if (route === 'skills' && parts[1]) content = await skillView(parts[1]);
      else if (route === 'skills') content = await skillsView();
      else if (route === 'templates' && parts[1]) content = await templateView(parts[1]);
      else if (route === 'templates') content = await templatesView();
      else if (route === 'runs' && parts[1] && parts[2]) content = await runItemView(parts[1], parts[2]);
      else if (route === 'runs' && parts[1]) content = await runView(parts[1]);
      else if (route === 'runs') content = await runsView();
      else content = head('Not found', 'Select a page from the navigation.');
      if (sequence !== renderSequence) return;
      app.removeAttribute('aria-busy');
      app.replaceChildren(content);
    } catch (error) {
      if (sequence !== renderSequence) return;
      app.removeAttribute('aria-busy');
      setNotice(error.message, true);
      app.replaceChildren(errorView(error));
    }
  }

  window.addEventListener('hashchange', render);
  if (!location.hash) location.hash = 'skills';
  else render();
})();
