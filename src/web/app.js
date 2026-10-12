'use strict';

(() => {
  const app = document.getElementById('app');
  const notice = document.getElementById('notice');
  let renderSequence = 0;
  let activeStream = null;

  function h(tag, attrs = {}, children = []) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'className') el.className = value;
      else if (key === 'textContent') el.textContent = value;
      else if (key === 'onClick') el.addEventListener('click', value);
      else if (key === 'onChange') el.addEventListener('change', value);
      else if (key === 'value') el.value = value;
      else if (key === 'checked') el.checked = value;
      else if (key === 'disabled') el.disabled = value;
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

  const ICON_PATHS = {
    load: ['M12 3v12', 'm7 8 5-5 5 5', 'M5 21h14'],
    analyze: ['M12 3l1.7 4.3L18 9l-4.3 1.7L12 15l-1.7-4.3L6 9l4.3-1.7L12 3z', 'M5 15l.8 2.2L8 18l-2.2.8L5 21l-.8-2.2L2 18l2.2-.8L5 15z'],
    mapping: ['M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.1 1.1', 'M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.1-1.1'],
    unload: ['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 14H6L5 6', 'M10 11v5', 'M14 11v5'],
    run: ['M8 5v14l11-7z'],
    cancel: ['M18 6 6 18', 'M6 6l12 12'],
    retry: ['M21 12a9 9 0 1 1-2.64-6.36', 'M21 3v6h-6'],
    download: ['M12 3v12', 'm7 10 5 5 5-5', 'M5 21h14'],
    code: ['m8 9-4 3 4 3', 'M16 9l4 3-4 3', 'M14 5l-4 14'],
    drag: ['M9 5h.01', 'M9 12h.01', 'M9 19h.01', 'M15 5h.01', 'M15 12h.01', 'M15 19h.01'],
    check: ['m5 12 4 4L19 6'],
    close: ['M18 6 6 18', 'M6 6l12 12'],
    spinner: ['M12 3a9 9 0 1 0 9 9'],
  };

  function icon(name, className = 'icon') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', className);
    for (const d of ICON_PATHS[name] || []) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    return svg;
  }

  function actionButton(label, iconName, className = 'button') {
    return h('button', { className, type: 'button' }, [
      icon(iconName),
      h('span', { textContent: label }),
    ]);
  }

  function loadingPanel(title, message) {
    return panel(title, h('div', { className: 'panel-body' }, h('div', { className: 'loading-state' }, [
      icon('spinner', 'icon spinner'),
      h('span', { textContent: message }),
    ])));
  }

  function openInputDialog({ title, label, placeholder, confirmText, iconName, validate, onConfirm }) {
    const dialog = h('dialog', { className: 'modal' });
    const input = h('input', { type: 'text', placeholder });
    const error = h('p', { className: 'modal-error' });
    const cancel = actionButton('Cancel', 'close');
    const confirm = actionButton(confirmText, iconName, 'button primary');
    confirm.type = 'submit';
    const form = h('form', { className: 'modal-form' }, [
      h('label', { className: 'modal-field' }, [h('span', { textContent: label }), input]),
      error,
      h('div', { className: 'modal-actions' }, [cancel, confirm]),
    ]);
    const close = () => dialog.close();
    cancel.addEventListener('click', close);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const value = input.value.trim();
      error.textContent = '';
      if (!value || (validate && !validate(value))) {
        error.textContent = `Enter a valid ${label}`;
        input.focus();
        return;
      }
      cancel.disabled = true;
      confirm.disabled = true;
      confirm.replaceChildren(icon('spinner', 'icon spinner'), h('span', { textContent: 'Working...' }));
      try {
        await onConfirm(value);
        close();
      } catch (err) {
        error.textContent = err.message;
        cancel.disabled = false;
        confirm.disabled = false;
        confirm.replaceChildren(icon(iconName), h('span', { textContent: confirmText }));
        input.focus();
      }
    });
    dialog.addEventListener('close', () => dialog.remove());
    dialog.append(h('div', { className: 'modal-head' }, [
      h('div', {}, [icon(iconName, 'modal-icon'), h('h2', { textContent: title })]),
      h('button', { className: 'icon-button', type: 'button', 'aria-label': 'Close', onClick: close }, icon('close')),
    ]), form);
    document.body.append(dialog);
    dialog.showModal();
    input.focus();
    return dialog;
  }

  function setNotice(message = '', isError = false) {
    notice.textContent = message;
    notice.className = `notice${message ? ' visible' : ''}${isError ? ' error' : ''}`;
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

  function stopRunStream() {
    if (activeStream) activeStream.abort();
    activeStream = null;
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
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let streamDone = false;
      while (true) {
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
          if (data) {
            const event = JSON.parse(data);
            onEvent(event);
            if (event.type === 'done') {
              streamDone = true;
              controller.abort();
              break;
            }
          }
        }
        if (streamDone) break;
      }
    } catch (error) {
      if (error.name !== 'AbortError') setNotice(error.message, true);
    } finally {
      if (activeStream === controller) activeStream = null;
    }
  }

  function watchOperation(ref, operationId, onEvent = () => {}) {
    stopRunStream();
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
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
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
            const event = JSON.parse(data);
            onEvent(event);
            if (event.error) {
              throw new Error(event.error.action ? `${event.error.message}. ${event.error.action}` : event.error.message);
            }
            if (event.type === 'done') {
              controller.abort();
              resolve((event.operation || event.job).result);
              return;
            }
            const operation = event.operation || event.job;
            if (operation && ['completed', 'failed', 'canceled', 'interrupted'].includes(operation.status)) {
              controller.abort();
              if (operation.status !== 'completed') {
                const message = operation.error?.message || `Operation ${operation.status}`;
                const action = operation.error?.action ? `. ${operation.error.action}` : '';
                throw new Error(`${message}${action}`);
              }
              resolve(operation.result);
              return;
            }
          }
        }
        throw new Error('Operation stream ended before it finished');
      } catch (error) {
        if (error.name === 'AbortError') return;
        reject(error);
      }
    });
  }

  async function startOperation(path, body, method = 'POST') {
    const operation = await api(path, { method, body });
    const ref = operation.input?.ref || body.ref;
    return watchOperation(ref, operation.operation_id);
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
    invalid: 'Invalid',
    unanalyzed: 'Unanalyzed',
    ready: 'Ready',
    failed: 'Failed',
    partial: 'Partial',
    canceled: 'Canceled',
    interrupted: 'Interrupted',
    running: 'Running',
    queued: 'Queued',
    canceling: 'Canceling',
    'dry-run': 'Dry Run',
    analyzing: 'Analyzing',
    stale: 'Stale',
    unverified: 'Unverified',
    missing: 'Missing',
  };

  function statusBadge(status) {
    const safe = String(status || 'unknown').toLowerCase();
    const known = Object.keys(STATUS_LABELS);
    return h('span', {
      className: `badge ${known.includes(safe) ? safe : 'unknown'}`,
      textContent: STATUS_LABELS[safe] || safe,
    });
  }

  function codeBlock(value) {
    if (value === null || value === undefined) return h('span', { className: 'muted', textContent: 'Not recorded' });
    const code = h('code');
    code.innerHTML = window.SkillAppMarkdown.highlightJson(value);
    return h('pre', { className: 'code-block' }, code);
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
      icon('code'),
      h('span', { textContent: codeLabel }),
      h('span', { className: 'toggle-track', 'aria-hidden': 'true' }, h('span', { className: 'toggle-thumb' })),
    ]);
    body.replaceChildren(renderUI());
    return panel(title, body, control);
  }

  function editableText(value, onCommit) {
    const button = h('button', { className: 'inline-edit', type: 'button', textContent: value || '—' });
    button.addEventListener('click', () => {
      const input = h('input', { className: 'inline-edit-input', type: 'text', value: value || '' });
      input.setAttribute('aria-label', 'Column name');
      button.replaceWith(input);
      input.focus();
      input.select();
      let finished = false;
      const restore = () => input.replaceWith(button);
      const commit = async () => {
        if (finished) return;
        finished = true;
        const next = input.value.trim();
        if (!next || next === value) {
          restore();
          return;
        }
        try {
          await onCommit(next);
        } catch (error) {
          setNotice(error.message, true);
          restore();
        }
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); input.blur(); }
        if (event.key === 'Escape') { finished = true; restore(); }
      });
    });
    return button;
  }

  function editableColumnTable(kind, specs, canEdit, onSave) {
    const isInput = kind === 'inputs';
    const headers = isInput
      ? ['', 'Column', 'Key', 'Type', 'Required', 'Default', 'Constraints / Notes']
      : ['', 'Column', 'Key', 'Type', 'Value Path', 'Precision'];
    const widths = isInput
      ? [42, 180, 130, 100, 84, 120, null]
      : [42, 180, 130, 100, 190, null];
    const table = h('table', { className: `schema-table schema-table-${isInput ? 'inputs' : 'outputs'}` });
    const colgroup = h('colgroup');
    for (const width of widths) colgroup.append(h('col', width === null ? {} : { style: `width:${width}px` }));
    const thead = h('thead');
    const headerRow = h('tr');
    for (const header of headers) headerRow.append(h('th', { scope: 'col', textContent: header }));
    thead.append(headerRow);
    const tbody = h('tbody');
    let dragSource = null;

    const commitChange = async (change) => {
      const next = JSON.parse(JSON.stringify(specs));
      change(next);
      await onSave({ [kind]: next });
    };

    if (!specs.length) {
      const td = h('td', { colSpan: headers.length });
      td.append(empty('No data'));
      tbody.append(h('tr', {}, td));
    }

    specs.forEach((spec, index) => {
      const row = h('tr');
      const dragHandle = canEdit
        ? h('button', {
          className: 'drag-handle',
          type: 'button',
          draggable: 'true',
          title: 'Drag or use Arrow Up / Arrow Down to reorder',
          'aria-label': `Reorder ${spec.label || spec.key}`,
        }, icon('drag'))
        : null;
      if (dragHandle) {
        dragHandle.addEventListener('dragstart', (event) => {
          dragSource = { kind, index };
          row.classList.add('dragging');
          event.dataTransfer?.setData('text/plain', String(index));
          if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        });
        dragHandle.addEventListener('dragend', () => {
          dragSource = null;
          row.classList.remove('dragging');
          row.classList.remove('drag-over');
        });
        dragHandle.addEventListener('keydown', async (event) => {
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
          event.preventDefault();
          const target = event.key === 'ArrowUp' ? index - 1 : index + 1;
          if (target < 0 || target >= specs.length) return;
          await commitChange((next) => {
            const [moved] = next.splice(index, 1);
            next.splice(target, 0, moved);
          });
        });
      }
      row.addEventListener('dragover', (event) => {
        if (dragSource?.kind === kind) {
          event.preventDefault();
          row.classList.add('drag-over');
        }
      });
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
      row.addEventListener('drop', async (event) => {
        event.preventDefault();
        row.classList.remove('drag-over');
        if (!dragSource || dragSource.kind !== kind || dragSource.index === index) return;
        await commitChange((next) => {
          const [moved] = next.splice(dragSource.index, 1);
          next.splice(index, 0, moved);
        });
      });

      const dragCell = h('td', { className: 'drag-cell' }, dragHandle);
      const columnCell = h('td', { className: 'column-cell' }, editableText(spec.label || spec.key, async (label) => {
        await commitChange((next) => { next[index].label = label; });
      }));
      const cells = [
        dragCell,
        columnCell,
        h('td', {}, h('span', { className: 'mono', textContent: spec.key || '—' })),
        h('td', {}, h('span', { className: 'mono', textContent: spec.type || '—' })),
      ];
      if (isInput) {
        cells.push(
          h('td', { textContent: spec.required ? 'Yes' : 'No' }),
          h('td', { textContent: formatMeta(spec.default) }),
          h('td', { textContent: specMeta(spec) }),
        );
      } else {
        cells.push(
          h('td', {}, h('span', { className: 'mono', textContent: spec.from || '—' })),
          h('td', { textContent: spec.round === undefined ? '—' : String(spec.round) }),
        );
      }
      for (const cell of cells) row.append(cell);
      tbody.append(row);
    });

    table.append(colgroup, thead, tbody);
    const wrap = h('div', { className: 'table-wrap', role: 'region', tabindex: '0', 'aria-label': isInput ? 'Input Fields' : 'Output Fields' });
    wrap.append(table);
    return wrap;
  }

  function ioContractPanel(ref, schema, canEdit) {
    const body = h('div', { className: 'panel-body toggle-body' });
    let showJson = false;
    const control = h('button', {
      className: 'code-toggle',
      type: 'button',
      role: 'switch',
      'aria-checked': 'false',
      'aria-label': 'Show JSON',
      onClick: () => {
        showJson = !showJson;
        control.classList.toggle('active', showJson);
        control.setAttribute('aria-checked', String(showJson));
        control.setAttribute('aria-label', `${showJson ? 'Hide' : 'Show'} JSON`);
        body.replaceChildren(showJson ? codeBlock(schema) : contractBody());
      },
    }, [
      icon('code'),
      h('span', { textContent: 'JSON' }),
      h('span', { className: 'toggle-track', 'aria-hidden': 'true' }, h('span', { className: 'toggle-thumb' })),
    ]);
    const save = async (patch) => {
      const next = { ...schema, ...patch };
      await api(`/api/skills/${encoded(ref)}/io-schema`, { method: 'PUT', body: { schema: next } });
      setNotice('IO Schema saved');
      await render({ preserveScroll: true });
    };
    const contractBody = () => h('div', { className: 'contract-body' }, [
      section(`Inputs (${schema.inputs.length})`, editableColumnTable('inputs', schema.inputs, canEdit, save)),
      section(`Outputs (${schema.outputs.length})`, editableColumnTable('outputs', schema.outputs, canEdit, save)),
    ]);
    body.replaceChildren(contractBody());
    return panel('IO Schema', body, control);
  }

  function templateDefinitionPanel(template) {
    const inputs = Array.isArray(template?.mapping?.inputs) ? template.mapping.inputs : [];
    const outputs = Array.isArray(template?.mapping?.outputs) ? template.mapping.outputs : [];
    return togglePanel('Template Definition', 'JSON', () => h('div', { className: 'contract-body' }, [
      section(`Inputs (${inputs.length})`, dataTable(
        ['Key', 'Field ID', 'Type', 'Required', 'Default', 'Rules'],
        mappingInputRows(inputs),
        'Template Input Mapping',
      )),
      section(`Outputs (${outputs.length})`, dataTable(
        ['Key', 'Field ID', 'Type', 'Value Path', 'Precision'],
        mappingOutputRows(outputs),
        'Template Output Mapping',
      )),
    ]), () => codeBlock(template));
  }

  function dataPanel(body) {
    return panel(null, body);
  }

  function head(title, description = '', actions = null) {
    return h('div', { className: 'view-head' }, [
      h('div', {}, [
        h('h1', { textContent: title }),
        description ? h('p', { className: 'muted', textContent: description }) : null,
      ]),
      actions,
    ]);
  }

  function empty(message) {
    return h('div', { className: 'empty', textContent: message });
  }

  function dataTable(headers, rows, label = 'Data Table') {
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

  function feishuBaseLink(target = {}) {
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

  function openLoadDialog() {
    openInputDialog({
      title: 'Load Skill',
      label: 'Skill Root',
      placeholder: '/Users/me/skills/my-skill',
      confirmText: 'OK',
      iconName: 'check',
      onConfirm: async (sourcePath) => {
        const result = await startOperation('/api/skills/load', { source_path: sourcePath }, 'POST');
        location.hash = `skills/${encoded(result.ref)}`;
      },
    });
  }

  function openMappingDialog(ref) {
    openInputDialog({
      title: 'Mapping',
      label: 'Feishu Base URL',
      placeholder: 'https://my.feishu.cn/base/...?table=...&view=...',
      confirmText: 'Mapping',
      iconName: 'mapping',
      onConfirm: async (url) => {
        const result = await startOperation('/api/mappings', { ref, url }, 'POST');
        location.hash = `templates/${encoded(result.template.template_id)}`;
      },
    });
  }

  async function skillsView() {
    const skills = await api('/api/skills');
    const rows = skills.map((skill) => [
      hashLink(skill.ref, `#skills/${encoded(skill.ref)}`),
      statusBadge(skill.status || 'invalid'),
      h('span', { textContent: formatDate(skill.loaded_at) }),
      h('span', { className: 'truncate', textContent: skill.source || '—' }),
    ]);
    const load = actionButton('Load', 'load', 'button primary');
    load.addEventListener('click', openLoadDialog);
    return fragment(
      head('Skills', '', h('div', { className: 'run-actions' }, load)),
      dataPanel(h('div', { className: 'panel-body flush' }, dataTable(
        ['Ref', 'Status', 'Loaded', 'Source'],
        rows,
      ))),
    );
  }

  function skillActions(ref, analysis, hasSchema, activeOperations, setAnalysisLoading, restoreAnalysis) {
    const analyzeLabel = analysis?.state === 'missing' || !analysis?.state ? 'Analyze' : 'Re-analyze';
    const analyze = actionButton(activeOperations.analyze ? 'Analyzing' : analyzeLabel, 'analyze', 'button primary');
    if (activeOperations.analyze) {
      analyze.disabled = true;
      analyze.replaceChildren(icon('spinner', 'icon spinner'), h('span', { textContent: 'Analyzing' }));
    }
    analyze.addEventListener('click', async () => {
      analyze.disabled = true;
      analyze.replaceChildren(icon('spinner', 'icon spinner'), h('span', { textContent: 'Analyzing' }));
      setAnalysisLoading();
      try {
        await startOperation(`/api/skills/${encoded(ref)}/analyze`, {}, 'POST');
        setNotice('');
        render();
      } catch (error) {
        restoreAnalysis();
        setNotice(error.message, true);
        analyze.disabled = false;
        analyze.replaceChildren(icon('analyze'), h('span', { textContent: analyzeLabel }));
      }
    });

    const mapping = actionButton(activeOperations.mapping ? 'Mapping...' : 'Mapping', 'mapping', 'button');
    mapping.disabled = !hasSchema || Boolean(activeOperations.mapping);
    mapping.title = hasSchema ? 'Create a Template from this Skill' : 'Analyze the Skill first';
    if (activeOperations.mapping) mapping.replaceChildren(icon('spinner', 'icon spinner'), h('span', { textContent: 'Mapping...' }));
    mapping.addEventListener('click', () => openMappingDialog(ref));

    const unload = actionButton('Unload', 'unload', 'button danger');
    unload.disabled = Boolean(activeOperations.analyze || activeOperations.mapping || activeOperations.unload);
    unload.addEventListener('click', async () => {
      if (!window.confirm('Unload this Skill? Local files will be removed. Feishu columns will remain.')) return;
      unload.disabled = true;
      try {
        await startOperation(`/api/skills/${encoded(ref)}`, {}, 'DELETE');
        location.hash = 'skills';
      } catch (error) {
        setNotice(error.message, true);
        unload.disabled = false;
      }
    });
    return h('div', { className: 'run-actions' }, [analyze, mapping, unload]);
  }

  async function skillView(ref) {
    const skill = await api(`/api/skills/${encoded(ref)}`);
    const analysis = skill.analysis || {};
    const schema = analysis.schema || null;
    const activeOperations = skill.operations || {};
    const contractSlot = h('div');
    const mappingSlot = h('div');
    const paintAnalysis = () => {
      contractSlot.replaceChildren(analysis.schema
        ? ioContractPanel(ref, analysis.schema, !activeOperations.analyze && !activeOperations.mapping && !activeOperations.unload)
        : panel('IO Schema', h('div', { className: 'panel-body' }, empty('No IO Schema available.'))));
    };
    const setAnalysisLoading = () => {
      contractSlot.replaceChildren(loadingPanel('IO Schema', 'Analyzing Skill IO...'));
    };
    const restoreAnalysis = () => paintAnalysis();
    paintAnalysis();
    if (activeOperations.analyze) setAnalysisLoading();
    if (activeOperations.mapping) mappingSlot.replaceChildren(loadingPanel('Mapping', 'Creating Template...'));
    const summary = panel('Summary', h('div', { className: 'panel-body' }, kv([
      ['Ref', skill.ref],
      ['Status', statusBadge(skill.status || 'invalid')],
      ['Fingerprint', h('span', { className: 'mono', textContent: skill.hash || '—' })],
      ['Loaded', formatDate(skill.loaded_at)],
      ['Source', skill.source || '—'],
    ])));
    if (activeOperations.analyze) {
      watchOperation(ref, activeOperations.analyze.operation_id).then(() => render()).catch((error) => setNotice(error.message, true));
    } else if (activeOperations.mapping) {
      watchOperation(ref, activeOperations.mapping.operation_id)
        .then((result) => { location.hash = `templates/${encoded(result.template.template_id)}`; })
        .catch((error) => setNotice(error.message, true));
    }

    return fragment(
      h('div', { className: 'view-head' }, [
        h('div', { className: 'view-title' }, [
          h('h1', { textContent: skill.ref }),
        ]),
        skillActions(ref, analysis, Boolean(schema), activeOperations, setAnalysisLoading, restoreAnalysis),
      ]),
      summary,
      analysis.state === 'stale' || analysis.state === 'unverified' ? h('div', { className: 'warning-box', textContent: analysis.reason }) : null,
      contractSlot,
      mappingSlot,
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
        `${template.inputs} in / ${template.outputs} out`,
        last ? statusBadge(last.status) : h('span', { className: 'muted', textContent: 'Never' }),
        h('span', { textContent: formatDate(template.created_at) }),
      ];
    });
    return fragment(
      head('Templates'),
      dataPanel(h('div', { className: 'panel-body flush' }, dataTable(
        ['Ref', 'Template ID', 'IO', 'Last Run', 'Created'],
        rows,
      ))),
    );
  }

  function runControl(template) {
    const allRows = h('input', { type: 'checkbox' });
    const allRowsField = h('label', { className: 'run-option' }, [
      allRows,
      h('span', { textContent: 'All Rows' }),
    ]);
    const button = actionButton('Run', 'run', 'button primary');
    button.addEventListener('click', async () => {
      button.disabled = true;
      setNotice('');
      try {
        if (allRows.checked && !window.confirm('Run all rows and write results back to the table?')) return;
        const run = await api('/api/runs', {
          method: 'POST',
          body: {
            template_id: template.template_id,
            trigger: allRows.checked ? 'all' : 'pending',
          },
        });
        location.hash = `runs/${encoded(run.run_id)}`;
      } catch (error) {
        setNotice(error.message, true);
        button.disabled = false;
      }
    });
    return h('div', { className: 'run-actions' }, [allRowsField, button]);
  }

  async function templateView(id) {
    const data = await api(`/api/templates/${encoded(id)}`);
    const template = data.template;
    const target = template.target || {};
    const skill = template.skill || {};
    return fragment(
      h('div', { className: 'view-head' }, [
        h('div', { className: 'view-title' }, [
          h('h1', { textContent: data.ref }),
        ]),
        runControl(template),
      ]),
      panel('Summary', h('div', { className: 'panel-body' }, kv([
        ['Template ID', h('span', { className: 'mono', textContent: template.template_id || '—' })],
        ['Skill', skillLink(skill.path)],
        ['Skill Hash', h('span', { className: 'mono', textContent: skill.hash || '—' })],
        ['Feishu Base URL', feishuBaseLink(target)],
        ['Created', formatDate(template.created_at)],
      ]))),
      templateDefinitionPanel(template),
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

  function isRunActive(status) {
    return status === 'queued' || status === 'running' || status === 'canceling';
  }

  function runContent(runId, run, liveLogs) {
    const items = Array.isArray(run.items) ? run.items : [];
    const rows = items.map((item) => [
      hashLink(item.record_id, `#runs/${encoded(runId)}/${encoded(item.record_id)}`),
      statusBadge(item.status),
      item.stage || '—',
      item.ms === null || item.ms === undefined ? '—' : `${item.ms} ms`,
      item.error || '—',
    ]);
    const total = run.total ?? items.length;
    const completed = run.completed ?? items.filter((item) => item.status !== 'queued' && item.status !== 'running').length;
    const percent = total ? Math.min(100, Math.round((completed / total) * 100)) : 0;
    const actions = h('div', { className: 'run-actions' });
    if (isRunActive(run.status)) {
      const cancel = actionButton('Cancel', 'cancel');
      cancel.disabled = run.status === 'canceling';
      cancel.addEventListener('click', async (event) => {
          event.currentTarget.disabled = true;
          try {
            await api(`/api/runs/${encoded(runId)}/cancel`, { method: 'POST' });
          } catch (error) {
            setNotice(error.message, true);
            event.currentTarget.disabled = false;
          }
      });
      actions.append(cancel);
    }
    if (!isRunActive(run.status) && (run.failed || 0) > 0) {
      const retry = actionButton('Retry', 'retry', 'button primary');
      retry.addEventListener('click', async (event) => {
          event.currentTarget.disabled = true;
          try {
            const next = await api(`/api/runs/${encoded(runId)}/retry`, { method: 'POST' });
            location.hash = `runs/${encoded(next.run_id)}`;
          } catch (error) {
            setNotice(error.message, true);
            event.currentTarget.disabled = false;
          }
      });
      actions.append(retry);
    }

    const logPanel = h('div', { className: 'live-logs' });
    for (const [recordId, streams] of liveLogs.entries()) {
      logPanel.append(h('section', { className: 'live-log' }, [
        h('h3', { textContent: recordId }),
        h('div', { className: 'detail-grid' }, [
          panel('Stdout', h('div', { className: 'panel-body' }, streams.stdout ? codeBlock(streams.stdout) : empty('No output'))),
          panel('Stderr', h('div', { className: 'panel-body' }, streams.stderr ? codeBlock(streams.stderr) : empty('No output'))),
        ]),
      ]));
    }

    return fragment(
      h('div', { className: 'view-head' }, [
        h('div', { className: 'view-title' }, [
          h('h1', { textContent: run.run_id || runId }),
        ]),
        actions,
      ]),
      panel('Summary', h('div', { className: 'panel-body' }, kv([
        ['Status', statusBadge(run.status)],
        ['Template ID', h('span', { className: 'mono' }, templateLink(run.template_id))],
        ['Trigger', run.trigger || '—'],
        ['Progress', `${completed} / ${total}`],
        ['Progress Bar', h('div', { className: 'progress' }, h('div', { className: 'progress-bar', style: `width:${percent}%` }))],
        ['Started', formatDate(run.started_at)],
        ['Finished', formatDate(run.finished_at)],
        ['Succeeded / Failed', `${run.succeeded ?? '—'} / ${run.failed ?? '—'}`],
        ['Work Hash', h('span', { className: 'mono', textContent: run.work_hash || '—' })],
      ]))),
      panel('Run Items', h('div', { className: 'panel-body flush' }, dataTable(
        ['Record ID', 'Status', 'Stage', 'Duration', 'Error'],
        rows,
      ))),
      logPanel.childElementCount ? panel('Live Output', h('div', { className: 'panel-body' }, logPanel)) : null,
    );
  }

  async function runView(runId) {
    const initial = await api(`/api/runs/${encoded(runId)}`);
    const view = h('div');
    const liveLogs = new Map();
    let currentRun = initial;
    const refresh = (run) => {
      currentRun = run;
      view.replaceChildren(runContent(runId, run, liveLogs));
    };
    refresh(initial);
    watchRun(runId, (event) => {
      if (event.type === 'item-stage') {
        const item = (currentRun.items || []).find((entry) => entry.record_id === event.record_id);
        if (item) item.stage = event.stage;
        refresh(currentRun);
        return;
      }
      if (event.type === 'item-log') {
        const streams = liveLogs.get(event.record_id) || { stdout: '', stderr: '' };
        streams[event.stream] = `${streams[event.stream]}${event.chunk}`.slice(-24000);
        liveLogs.set(event.record_id, streams);
        refresh(currentRun);
        return;
      }
      if (event.run) refresh(event.run);
      if (event.type === 'error') setNotice(event.error?.message || 'Run failed', true);
    });
    return view;
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
        h('a', { className: 'button primary', href: url, download: true }, [icon('download'), h('span', { textContent: 'Download' })]),
      ]));
    }
    if (!(item.artifacts || []).length) artifacts.append(empty('No artifacts.'));

    return fragment(
      h('div', { className: 'view-head' }, [
        h('div', { className: 'view-title' }, [
          h('h1', { textContent: item.record_id || recordId }),
        ]),
      ]),
      panel('Status', h('div', { className: 'panel-body' }, kv([
        ['Status', statusBadge(item.status)],
        ['Stage', item.stage || '—'],
        ['Duration', item.ms === null || item.ms === undefined ? '—' : `${item.ms} ms`],
        ['Error', item.error || '—'],
        ['Input Hash', h('span', { className: 'mono', textContent: item.input_hash || '—' })],
      ]))),
      panel(`Artifacts (${(item.artifacts || []).length})`, h('div', { className: 'panel-body' }, artifacts)),
      h('div', { className: 'detail-grid' }, [
        panel('Stdout', h('div', { className: 'panel-body' }, codeBlock(item.logs?.stdout))),
        panel('Stderr', h('div', { className: 'panel-body' }, codeBlock(item.logs?.stderr))),
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
        (() => { const button = actionButton('Retry', 'retry', 'button primary'); button.addEventListener('click', render); return button; })(),
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

  async function render({ preserveScroll = false } = {}) {
    stopRunStream();
    const sequence = ++renderSequence;
    const previousScroll = preserveScroll ? { x: window.scrollX, y: window.scrollY } : null;
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
    if (!preserveScroll) app.replaceChildren(loadingView());

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
    } finally {
      if (previousScroll && sequence === renderSequence) {
        window.scrollTo({ left: previousScroll.x, top: previousScroll.y, behavior: 'instant' });
      }
    }
  }

  window.addEventListener('hashchange', render);
  if (!location.hash) location.hash = 'skills';
  else render();
})();
