import { actionButton, h, icon, setNotice } from './dom.js';
import { formatMeta, specMeta } from './format.js';

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

function loadingPanel(title, message, bodyClass = '') {
  return panel(title, h('div', { className: `panel-body${bodyClass ? ` ${bodyClass}` : ''}` }, h('div', { className: 'loading-state' }, [
    icon('spinner', 'icon spinner'),
    h('span', { textContent: message }),
  ])));
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

function breadcrumb(items) {
  const nav = h('nav', { className: 'breadcrumb', 'aria-label': 'Breadcrumb' });
  items.forEach((item, index) => {
    if (index) nav.append(h('span', { className: 'breadcrumb-sep', 'aria-hidden': 'true', textContent: '/' }));
    nav.append(h('a', { href: item.href, textContent: item.label }));
  });
  return nav;
}

function viewTitle(title, crumbs = null) {
  return h('div', { className: 'view-title' }, [
    crumbs ? breadcrumb(crumbs) : null,
    crumbs ? h('span', { className: 'breadcrumb-sep', 'aria-hidden': 'true', textContent: '/' }) : null,
    h('h1', { textContent: title }),
  ]);
}

function empty(message) {
  return h('div', { className: 'empty', textContent: message });
}

function kv(entries) {
  const list = h('dl', { className: 'kv' });
  for (const [key, value] of entries) {
    list.append(h('dt', { textContent: key }), h('dd', {}, value instanceof Node ? value : String(value ?? '—')));
  }
  return list;
}

function section(title, content) {
  return h('section', { className: 'contract-section' }, [
    h('h3', { textContent: title }),
    content,
  ]);
}

function dataTable(headers, rows, label = 'Data Table', className = null) {
  const table = h('table', className ? { className } : {});
  const colgroup = h('colgroup');
  for (let i = 0; i < headers.length; i += 1) colgroup.append(h('col'));
  table.append(colgroup);
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
  const wrap = h('div', { className: 'table-wrap', role: 'region', 'aria-label': label });
  wrap.append(table);
  return wrap;
}

/**
 * 分页列表：传统翻页（Prev / Next），每页 pageSize 条，默认看第 1 页（最新的在前）。
 * 只有一页时不画翻页条。数据本来就在本地，翻页只重画这张表，不再请求服务端。
 */
const PAGE_STATE_KEY = 'skillapp.pages';

function readPageState() {
  try {
    return JSON.parse(sessionStorage.getItem(PAGE_STATE_KEY) || '{}');
  } catch {
    return {};
  }
}

// 每个列表记住自己翻到第几页：重画、来回切页面都还在那一页（刷新也保留）。
const pageState = readPageState();

function rememberPage(key, page) {
  pageState[key] = page;
  try {
    sessionStorage.setItem(PAGE_STATE_KEY, JSON.stringify(pageState));
  } catch {
    // 隐私模式下写不了就算了，本次会话内仍然生效。
  }
}

function pagedTable(headers, rows, { pageSize = 10, label = 'Data Table' } = {}) {
  const slot = h('div');
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  // 记住的页号可能已经越界（列表变短了），夹回合法范围。
  let page = Math.min(Math.max(1, Number(pageState[label]) || 1), pages);

  const paint = () => {
    const start = (page - 1) * pageSize;
    // 只有列表自带滚动条与锁定表头；键盘要能滚，所以这里才需要可聚焦。
    const list = dataTable(headers, rows.slice(start, start + pageSize), label);
    list.classList.add('is-scrolling');
    list.tabIndex = 0;
    const children = [list];

    if (pages > 1) {
      // 页码与翻页合成一个控件：两个箭头按钮夹着静止的页码，跟着列表左对齐的总数。
      const prev = h('button', {
        className: 'icon-button',
        type: 'button',
        'aria-label': 'Previous page',
        title: 'Previous page',
        onClick: () => { if (page > 1) { page -= 1; paint(); } },
      }, icon('prev'));
      const next = h('button', {
        className: 'icon-button',
        type: 'button',
        'aria-label': 'Next page',
        title: 'Next page',
        onClick: () => { if (page < pages) { page += 1; paint(); } },
      }, icon('next'));
      prev.disabled = page <= 1;
      next.disabled = page >= pages;
      children.push(h('div', { className: 'table-pager' }, [
        h('span', { className: 'pager-total', textContent: `${rows.length} total` }),
        h('div', { className: 'pager-group', role: 'group', 'aria-label': `Page ${page} of ${pages}` }, [
          prev,
          h('span', { className: 'pager-page', textContent: `${page} / ${pages}` }),
          next,
        ]),
      ]));
    }

    rememberPage(label, page);
    // 注意：不能把 null 直接塞给 replaceChildren（会渲染成字面量 "null"）。
    slot.replaceChildren(...children.filter(Boolean));
  };

  paint();
  return slot;
}

function editableText(value, onCommit, label = 'Field name') {
  const button = h('button', { className: 'inline-edit', type: 'button', textContent: value || '—' });
  button.addEventListener('click', () => {
    const input = h('input', { className: 'inline-edit-input', type: 'text', value: value || '' });
    input.setAttribute('aria-label', label);
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

// Hovering the lower half of the last row means "insert after it", so a row can
// be dragged to the very bottom without adding a separate drop row.
function isAppendTarget(clientY, row, index, count) {
  if (index !== count - 1) return false;
  const rect = row.getBoundingClientRect();
  return rect.height > 0 && clientY - rect.top > rect.height / 2;
}

function clearDropHints(scope) {
  for (const el of scope.querySelectorAll('.drag-over, .drag-over-end')) {
    el.classList.remove('drag-over', 'drag-over-end');
  }
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
    entry.hint || '—',
  ]);
}

/** 可编辑的 Inputs / Outputs 契约表：行内改名 + 指针拖拽排序。 */
function editableSchemaTable(kind, specs, canEdit, onSave) {
  const isInput = kind === 'inputs';
  const headers = isInput
    ? ['', 'Field', 'Key', 'Type', 'Required', 'Default', 'Notes']
    : ['', 'Field', 'Key', 'Type', 'Value Path', 'Precision', 'Notes'];
  const table = h('table', { className: `schema-table schema-table-${isInput ? 'inputs' : 'outputs'}` });
  const colgroup = h('colgroup');
  for (let i = 0; i < headers.length; i += 1) colgroup.append(h('col'));
  const thead = h('thead');
  const headerRow = h('tr');
  for (const header of headers) headerRow.append(h('th', { scope: 'col', textContent: header }));
  thead.append(headerRow);
  const tbody = h('tbody');
  const rowEls = [];
  let dragSource = null;
  let dragHit = null;

  // Pointer-driven reorder: the native drag API auto-scrolls the page and the
  // table while dragging (and shows a ghost image following the cursor), so we
  // track the pointer ourselves and keep the layout completely still.
  const resolveDropTarget = (x, y) => {
    const el = document.elementFromPoint(x, y);
    const tr = el && el.closest ? el.closest('tr') : null;
    if (!tr || tr.parentElement !== tbody) return null;
    const target = rowEls.indexOf(tr);
    if (target < 0) return null;
    return { target, append: isAppendTarget(y, tr, target, specs.length), row: tr };
  };
  const applyDropHint = (hit) => {
    dragHit = hit;
    clearDropHints(tbody);
    if (!hit) return;
    hit.row.classList.add('drag-over');
    hit.row.classList.toggle('drag-over-end', hit.append);
  };
  const finishPointerDrag = () => {
    const source = dragSource;
    dragSource = null;
    dragHit = null;
    clearDropHints(tbody);
    document.body.classList.remove('is-dragging-rows');
    if (source?.handle?.hasPointerCapture?.(source.pointerId)) {
      source.handle.releasePointerCapture(source.pointerId);
    }
  };

  /**
   * `specs` 就是 mapping.inputs / outputs 本身：原地替换内容，外面的引用永远是最新的。
   * 改动后只重建这张表（不重绘页面），滚动位置、JSON 开关、其它面板都不受影响。
   */
  const setSpecs = (next) => {
    specs.length = 0;
    specs.push(...next);
    renderRows();
  };

  const commitChange = async (change) => {
    const before = JSON.parse(JSON.stringify(specs));
    const next = JSON.parse(JSON.stringify(specs));
    change(next);
    setSpecs(next);
    try {
      await onSave();
    } catch (error) {
      setSpecs(before);
      setNotice(error.message, true);
    }
  };

  function renderRows() {
    tbody.replaceChildren();
    rowEls.length = 0;
    if (!specs.length) {
      const td = h('td', { colSpan: headers.length });
      td.append(empty('No data'));
      tbody.append(h('tr', {}, td));
      return;
    }

    specs.forEach((spec) => {
      const unmapped = spec.mapped === false;
      const row = h('tr', unmapped ? { className: 'is-unmapped' } : {});
      rowEls.push(row);
      const dragHandle = canEdit
        ? h('button', {
          className: 'drag-handle',
          type: 'button',
          title: 'Drag to reorder',
          'aria-label': `Reorder ${spec.label || spec.key}`,
        }, icon('drag'))
        : null;
      if (dragHandle) {
        dragHandle.addEventListener('pointerdown', (event) => {
          if (event.button !== 0 || dragSource) return;
          event.preventDefault();
          dragSource = { kind, pointerId: event.pointerId, handle: dragHandle };
          try {
            dragHandle.setPointerCapture(event.pointerId);
          } catch {
            // Pointer capture only fails when the pointer is no longer active.
          }
          document.body.classList.add('is-dragging-rows');
        });
        dragHandle.addEventListener('pointermove', (event) => {
          if (dragSource?.pointerId !== event.pointerId) return;
          event.preventDefault();
          applyDropHint(resolveDropTarget(event.clientX, event.clientY));
        });
        dragHandle.addEventListener('pointerup', async (event) => {
          if (dragSource?.pointerId !== event.pointerId) return;
          const hit = resolveDropTarget(event.clientX, event.clientY) || dragHit;
          finishPointerDrag();
          if (!hit) return;
          const from = rowEls.indexOf(row);
          if (from < 0) return;
          if (hit.append ? from === specs.length - 1 : from === hit.target) return;
          await commitChange((next) => {
            const [moved] = next.splice(from, 1);
            if (hit.append) next.push(moved);
            else next.splice(hit.target, 0, moved);
          });
        });
        dragHandle.addEventListener('pointercancel', finishPointerDrag);
        dragHandle.addEventListener('lostpointercapture', () => {
          if (dragSource) finishPointerDrag();
        });
      }

      // 必填输入必须映射，勾选框默认勾上且禁用；其余输入/输出都可以自由勾选。
      const locked = isInput && spec.required === true;
      const checkbox = h('input', {
        className: 'map-check',
        type: 'checkbox',
        checked: !unmapped,
        disabled: !canEdit || locked,
        title: locked ? 'Required: must stay mapped' : 'Map to the Feishu table',
      });
      checkbox.setAttribute('aria-label', `Map ${spec.label || spec.key}`);
      checkbox.addEventListener('change', () => {
        const checked = checkbox.checked;
        // 失败时 commitChange 会还原并重画这张表，勾选框自己就回去了。
        commitChange((next) => {
          const target = next[rowEls.indexOf(row)];
          if (checked) delete target.mapped;
          else target.mapped = false;
        });
      });

      const dragCell = h('td', { className: 'drag-cell' },
        h('span', { className: 'drag-cell-inner' }, [dragHandle, checkbox]));
      const columnCell = h('td', { className: 'field-cell' }, editableText(spec.label || spec.key, async (label) => {
        await commitChange((next) => { next[rowEls.indexOf(row)].label = label; });
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
          h('td', { textContent: specMeta(spec) }),
        );
      }
      for (const cell of cells) row.append(cell);
      // 未映射的行不参与表读写，行内编辑也就没有意义。
      if (unmapped) for (const button of row.querySelectorAll('.inline-edit')) button.disabled = true;
      tbody.append(row);
    });
  }

  renderRows();
  table.append(colgroup, thead, tbody);
  const wrap = h('div', { className: 'table-wrap', role: 'region', 'aria-label': isInput ? 'Input Fields' : 'Output Fields' });
  wrap.append(table);
  return wrap;
}

export {
  panel,
  togglePanel,
  loadingPanel,
  dataPanel,
  head,
  breadcrumb,
  viewTitle,
  empty,
  kv,
  section,
  dataTable,
  pagedTable,
  editableSchemaTable,
  mappingInputRows,
  mappingOutputRows,
};
