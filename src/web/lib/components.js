import { actionButton, h, icon, setNotice } from './dom.js';
import { requiredDefault, specMeta } from './format.js';

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
  // 列表页的面板：按页面剩余高度自适应（表格自己滚、翻页条钉底），见 styles.css 的 .panel-fill。
  const section = panel(null, body);
  section.classList.add('panel-fill');
  return section;
}

function head(title, description = '', actions = null) {
  return h('div', { className: 'view-head' }, [
    h('div', {}, [
      h('h1', { className: 'page-title', textContent: title }),
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
    // 有面包屑 = 详情页，标题是 ID / 名字，不套大写。
    h('h1', { className: crumbs ? null : 'page-title', textContent: title }),
  ]);
}

function empty(message) {
  return h('div', { className: 'empty', textContent: message });
}

/**
 * 下拉筛选：原生 <select> 的浮层由系统绘制，macOS 上宽度和分组样式都不受控
 * （浮层总是比控件宽）。所以这里自绘浮层：宽度与控件一致，选项按业务对象分组。
 * `groups` 形如 [{ label: 'Skill', values: ['load-skill', ...] }]；label 可省略（平铺不分组）。
 * `any` 是"全部"那一项的文案。
 */
function selectMenu({ label, any = 'All Types', value = '', groups = [], onChange }) {
  const wrapper = h('div', { className: 'select-menu' });
  const shown = h('span', { className: 'truncate' });
  const trigger = h('button', {
    className: 'select-trigger',
    type: 'button',
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    'aria-label': label,
  }, [shown, icon('chevron')]);
  const popup = h('div', { className: 'select-popup', role: 'menu', 'aria-label': label, hidden: true });
  const options = [];

  const setOpen = (open) => {
    popup.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
    document[open ? 'addEventListener' : 'removeEventListener']('pointerdown', onOutside, true);
    if (open) popup.querySelector('[aria-checked="true"]')?.focus();
  };
  function onOutside(event) {
    if (!wrapper.contains(event.target)) setOpen(false);
  }

  const addOption = (optionValue, text) => {
    const option = h('button', {
      className: 'select-option',
      type: 'button',
      role: 'menuitemradio',
      'aria-checked': String(optionValue === value),
      textContent: text,
      onClick: () => {
        for (const item of options) item.setAttribute('aria-checked', String(item === option));
        shown.textContent = text;
        setOpen(false);
        trigger.focus();
        onChange(optionValue);
      },
    });
    options.push(option);
    if (optionValue === value) shown.textContent = text;
    return option;
  };

  popup.append(addOption('', any));
  for (const group of groups) {
    if (!group.values.length) continue;
    // 没有领域分组的筛选（比如 Trigger）不画组标题，直接平铺。
    if (group.label) popup.append(h('div', { className: 'select-group', role: 'presentation', textContent: group.label }));
    for (const item of group.values) popup.append(addOption(item, item));
  }

  trigger.addEventListener('click', () => setOpen(popup.hidden));
  popup.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      setOpen(false);
      trigger.focus();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const index = options.indexOf(document.activeElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    options[(index + step + options.length) % options.length].focus();
  });

  wrapper.append(trigger, popup);
  return wrapper;
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

// 页号只在当前模块内有效：切到别的模块由 router 调 resetPagedState() 清空，不跨模块、也不跨刷新。
const pageState = {};

function resetPagedState() {
  for (const key of Object.keys(pageState)) delete pageState[key];
}

function rememberedPage(label) {
  return Math.max(1, Number(pageState[label]) || 1);
}

/**
 * 服务端分页列表：每次只取当前这一页，`load(page)` 由调用方去请求（返回 `{ rows, total, page, page_size }`）。
 * 首屏由视图 `await`，所以页面不会出现空表；翻页时保留旧数据、箭头禁用，表格不重排。
 * `page` 可选：传了就从这一页开始（比如换了筛选条件要回到第 1 页），不传就用当前模块记住的页号。
 */
async function pagedTable({ label = 'Data Table', headers, load, page = rememberedPage(label) }) {
  const slot = h('div');
  const meta = h('span', { className: 'pager-meta' });
  const pagerPage = h('span', { className: 'pager-page' });
  const pagerGroup = h('div', { className: 'pager-group', role: 'group' });
  const prev = h('button', {
    className: 'icon-button',
    type: 'button',
    'aria-label': 'Previous page',
    title: 'Previous page',
  }, icon('prev'));
  const next = h('button', {
    className: 'icon-button',
    type: 'button',
    'aria-label': 'Next page',
    title: 'Next page',
  }, icon('next'));
  pagerGroup.append(prev, pagerPage, next);
  const pager = h('div', { className: 'table-pager' }, [meta, pagerGroup]);

  let current = page;
  let pages = 1;
  let busy = false;
  let list = null;

  const sync = () => {
    prev.disabled = busy || current <= 1;
    next.disabled = busy || current >= pages;
    pagerPage.textContent = `${current} / ${pages}`;
    pagerGroup.setAttribute('aria-label', `Page ${current} of ${pages}`);
  };

  const turn = async (target) => {
    busy = true;
    sync();
    try {
      const data = await load(target);
      current = data.page;
      pages = Math.max(1, Math.ceil(data.total / data.page_size));
      // 左边一行：记录总数 + 竖线 + 每页条数（页长由服务端给，改了 Settings 下次取页就变）。
      meta.replaceChildren(
        'Total ',
        h('b', { textContent: String(data.total) }),
        h('span', { className: 'pager-size' }, ['Size ', h('b', { textContent: String(data.page_size) })]),
      );
      rememberPage(label, current);
      const nextList = dataTable(headers, data.rows, label);
      // 只有列表自带滚动条与锁定表头；键盘要能滚，所以这里才需要可聚焦。
      nextList.classList.add('is-scrolling');
      nextList.tabIndex = 0;
      list?.remove();
      list = nextList;
      slot.replaceChildren(list, pager);
    } finally {
      busy = false;
      sync();
    }
  };

  const step = (delta) => {
    const target = current + delta;
    if (busy || target < 1 || target > pages) return;
    // 翻页失败只提示，不把已经看到的这一页清空。
    turn(target).catch((error) => setNotice(error.message, true));
  };
  prev.addEventListener('click', () => step(-1));
  next.addEventListener('click', () => step(1));

  // 首屏失败交给调用方（视图 → 路由器）去报错。
  await turn(current);
  return slot;
}

function rememberPage(label, page) {
  pageState[label] = page;
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

function mappingInputRows(entries) {
  return entries.map((entry) => [
    entry.key,
    h('span', { className: 'mono', textContent: entry.field_id || '—' }),
    h('span', { className: 'mono', textContent: entry.type || '—' }),
    requiredDefault(entry),
    specMeta(entry),
  ]);
}

function mappingOutputRows(entries) {
  return entries.map((entry) => [
    entry.key,
    h('span', { className: 'mono', textContent: entry.field_id || '—' }),
    h('span', { className: 'mono', textContent: entry.type || '—' }),
    h('span', { className: 'mono', textContent: entry.from || '—' }),
    entry.hint || '—',
  ]);
}

/** 可编辑的 Inputs / Outputs 契约表：行内改名 + 指针拖拽排序。 */
function editableSchemaTable(kind, specs, canEdit, onSave) {
  const isInput = kind === 'inputs';
  const headers = isInput
    // Required 与 Default 在界面上并成一列（存储上仍是两个字段）；输出不显示 Precision。
    ? ['', 'Field', 'Key', 'Type', 'Required [Default]', 'Notes']
    : ['', 'Field', 'Key', 'Type', 'Value Path', 'Notes'];
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
        title: locked ? 'Required: must stay mapped' : 'Map to the Lark table',
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
          h('td', { textContent: requiredDefault(spec) }),
          h('td', { textContent: specMeta(spec) }),
        );
      } else {
        cells.push(
          h('td', {}, h('span', { className: 'mono', textContent: spec.from || '—' })),
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
  viewTitle,
  empty,
  kv,
  section,
  dataTable,
  pagedTable,
  resetPagedState,
  selectMenu,
  editableSchemaTable,
  mappingInputRows,
  mappingOutputRows,
};
