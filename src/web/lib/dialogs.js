import { api, startOperation } from './api.js';
import { h, icon, setNotice, textButton } from './dom.js';
import { encoded, triggerLabel } from './format.js';
import { larkBaseLink } from './links.js';

/** 输入弹窗：所有弹框都不带装饰性 Icon，只有文字按钮与关闭按钮。 */
function openInputDialog({ title, label, placeholder, confirmText, validate, onConfirm }) {
  const dialog = h('dialog', { className: 'modal' });
  const input = h('input', { type: 'text', placeholder });
  const error = h('p', { className: 'modal-error' });
  const cancel = textButton('Cancel');
  const confirm = textButton(confirmText, 'button primary');
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
      confirm.replaceChildren(h('span', { textContent: confirmText }));
      input.focus();
    }
  });
  dialog.addEventListener('close', () => dialog.remove());
  dialog.append(h('div', { className: 'modal-head' }, [
    h('h2', { textContent: title }),
    h('button', { className: 'icon-button', type: 'button', 'aria-label': 'Close', onClick: close }, icon('close')),
  ]), form);
  document.body.append(dialog);
  dialog.showModal();
  input.focus();
  return dialog;
}

/** 上传时客户端先滤这些：服务端还会再挡一次（见 core/skill-upload.js）。 */
const UPLOAD_SKIP = new Set(['node_modules', '__pycache__', '.venv', 'venv', '.git', '.DS_Store']);

/** 目录选择器（webkitdirectory 那条退路）给的文件带 `webkitRelativePath`，去掉根目录那一段就是相对路径。 */
const relativeParts = (file) => String(file.webkitRelativePath || file.name).split('/').slice(1);

const isSkipped = (rel) => rel.split('/').some((part) => UPLOAD_SKIP.has(part));

/**
 * 选一个文件夹（必须在用户手势里调用），归一成 `{ root, entries: [{ rel, file }] }`；取消返回 null。
 *
 * 优先 File System Access 的 `showDirectoryPicker`：它不会再弹一次"确认上传整个文件夹"那样的
 * 浏览器确认框；Safari / Firefox 没有这个 API，退回隐藏的 `input[webkitdirectory]`。
 */
async function pickSkillFolder() {
  if (window.showDirectoryPicker) {
    let handle;
    try {
      handle = await window.showDirectoryPicker({ id: 'skillapp-skill-folder', mode: 'read' });
    } catch (error) {
      if (error?.name === 'AbortError') return null;   // 用户取消：什么都不做
      throw error;
    }
    const entries = [];
    const walk = async (dir, prefix) => {
      for await (const entry of dir.values()) {
        if (entry.kind === 'file') entries.push({ rel: `${prefix}${entry.name}`, file: await entry.getFile() });
        else await walk(entry, `${prefix}${entry.name}/`);
      }
    };
    await walk(handle, '');
    return { root: handle.name, entries };
  }
  const input = h('input', { type: 'file', multiple: true, webkitdirectory: true, hidden: true });
  document.body.append(input);
  try {
    return await new Promise((resolve) => {
      input.addEventListener('change', () => {
        const all = [...input.files];
        const root = all.length ? String(all[0].webkitRelativePath).split('/')[0] : '';
        resolve(all.length ? { root, entries: all.map((file) => ({ rel: relativeParts(file).join('/'), file })) } : null);
      }, { once: true });
      input.click();
    });
  } finally {
    input.remove();
  }
}

/**
 * 装载 = 把本地 Skill 目录**上传**到 SkillApp。交互是"一次选择 + 一次确认"：
 * 点 Load 先弹系统选目录，再由弹框把要装载的东西摆出来（文件夹 / 文件数 / 跳过几个依赖文件），
 * 点 OK 才开始上传 —— 上传进度与错误都显示在这里。返回装载后的 ref；取消返回 null。
 */
async function openLoadDialog() {
  let picked;
  try {
    picked = await pickSkillFolder();
  } catch (error) {
    setNotice(error.message, true);
    return null;
  }
  if (!picked) return null;

  return new Promise((resolve) => {
    const dialog = h('dialog', { className: 'modal' });
    const folderValue = h('span', { className: 'truncate' });
    const filesValue = h('span', { className: 'mono' });
    const status = h('p', { className: 'modal-note' });
    const error = h('p', { className: 'modal-error' });
    const change = textButton('Change Folder', 'button modal-actions-option');
    const cancel = textButton('Cancel');
    const confirm = textButton('OK', 'button primary');
    confirm.type = 'submit';

    let kept = [];
    let skipped = [];
    let root = '';
    let sessionId = null;
    let committed = false;

    const note = (text) => { status.textContent = text; };
    const close = (value) => { resolve(value); dialog.close(); };
    // 会话建了却没提交：丢掉，别在服务端留垃圾（提交过的由 worker 自己清）。
    const discardSession = () => {
      if (!sessionId || committed) return;
      const id = sessionId;
      sessionId = null;
      void api(`/api/skills/uploads/${encoded(id)}`, { method: 'DELETE' }).catch(() => {});
    };

    const applyPicked = (next) => {
      root = next.root;
      kept = next.entries.filter(({ rel }) => !isSkipped(rel));
      skipped = next.entries.filter(({ rel }) => isSkipped(rel));
      folderValue.textContent = root;
      folderValue.title = root;
      filesValue.textContent = `${kept.length} file(s)${skipped.length ? ` · ${skipped.length} dependency file(s) skipped` : ''}`;
      confirm.disabled = !kept.length;
      error.textContent = '';
      note('');
    };
    applyPicked(picked);

    change.addEventListener('click', async () => {
      change.disabled = true;
      try {
        const next = await pickSkillFolder();
        if (next) applyPicked(next);
      } catch (err) {
        error.textContent = err.message;
      }
      change.disabled = false;
    });

    const form = h('form', { className: 'modal-form' }, [
      h('div', { className: 'modal-fields' }, [
        h('div', { className: 'modal-field' }, [h('span', { textContent: 'Folder' }), folderValue]),
        h('div', { className: 'modal-field' }, [h('span', { textContent: 'Files' }), filesValue]),
      ]),
      status,
      error,
      h('div', { className: 'modal-actions' }, [change, cancel, confirm]),
    ]);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!kept.length) return;
      confirm.disabled = true;
      cancel.disabled = true;
      change.disabled = true;
      error.textContent = '';
      try {
        const created = await api('/api/skills/uploads', { method: 'POST', body: { ref: root } });
        sessionId = created.upload_id;
        let sent = 0;
        for (const { rel, file } of kept) {
          note(`Uploading ${sent + 1} / ${kept.length} · ${rel}`);
          const response = await fetch(`/api/skills/uploads/${sessionId}/files?path=${encodeURIComponent(rel)}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/octet-stream' },
            credentials: 'same-origin',
            body: file,
          });
          if (!response.ok) {
            const payload = await response.json().catch(() => null);
            throw new Error(payload?.error?.message || `Upload failed (${response.status})`);
          }
          sent += 1;
        }
        note('Loading...');
        committed = true;   // 暂存交给 worker 清，这里别再丢
        const result = await startOperation(`/api/skills/uploads/${sessionId}/commit`, {}, 'POST');
        close(result?.ref || root);
      } catch (err) {
        discardSession();
        note('');
        error.textContent = err.message;
        confirm.disabled = false;
        cancel.disabled = false;
        change.disabled = false;
      }
    });

    cancel.addEventListener('click', () => { discardSession(); close(null); });
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); discardSession(); close(null); });
    dialog.addEventListener('close', () => resolve(null));

    dialog.append(
      h('div', { className: 'modal-head' }, [
        h('h2', { textContent: 'Load Skill' }),
        h('button', {
          className: 'icon-button',
          type: 'button',
          'aria-label': 'Close',
          onClick: () => { discardSession(); close(null); },
        }, icon('close')),
      ]),
      form,
    );
    document.body.append(dialog);
    dialog.showModal();
  });
}

/** 只反馈信息的弹框：标题 + 若干「字段 / 值」；说明放在底部与按钮同一行的左侧。 */
/** 需要用户确认的弹框（替代 window.confirm）：返回 Promise<boolean>。 */
function openConfirmDialog({ title, message, confirmText = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const dialog = h('dialog', { className: 'modal' });
    let answered = false;
    const finish = (value) => {
      if (answered) return;
      answered = true;
      resolve(value);
      dialog.close();
    };
    const cancel = textButton('Cancel');
    const confirm = textButton(confirmText, danger ? 'button danger' : 'button primary');
    cancel.addEventListener('click', () => finish(false));
    confirm.addEventListener('click', () => finish(true));
    // Esc 与右上角 ✕ 都算放弃。
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(false); });
    dialog.addEventListener('close', () => { if (!answered) { answered = true; resolve(false); } dialog.remove(); });
    dialog.append(
      h('div', { className: 'modal-head' }, [
        h('h2', { textContent: title }),
        h('button', { className: 'icon-button', type: 'button', 'aria-label': 'Close', onClick: () => finish(false) }, icon('close')),
      ]),
      h('div', { className: 'modal-form' }, [
        h('p', { className: 'modal-text', textContent: message }),
        h('div', { className: 'modal-actions' }, [cancel, confirm]),
      ]),
    );
    document.body.append(dialog);
    dialog.showModal();
    confirm.focus();
  });
}

/** 提示弹框：只有 OK（页面读不出来、路由不存在这类"告知 + 收尾"）。 */
function openAlertDialog({ title, message, confirmText = 'OK' }) {
  return new Promise((resolve) => {
    const dialog = h('dialog', { className: 'modal' });
    let answered = false;
    const finish = () => {
      if (answered) return;
      answered = true;
      resolve();
      dialog.close();
    };
    const ok = textButton(confirmText, 'button primary');
    ok.addEventListener('click', finish);
    // Esc 与右上角 ✕ 都算关掉。
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(); });
    dialog.addEventListener('close', () => { if (!answered) { answered = true; resolve(); } dialog.remove(); });
    dialog.append(
      h('div', { className: 'modal-head' }, [
        h('h2', { textContent: title }),
        h('button', { className: 'icon-button', type: 'button', 'aria-label': 'Close', onClick: finish }, icon('close')),
      ]),
      h('div', { className: 'modal-form' }, [
        h('p', { className: 'modal-text', textContent: message }),
        h('div', { className: 'modal-actions' }, ok),
      ]),
    );
    document.body.append(dialog);
    dialog.showModal();
    ok.focus();
  });
}

function openMappingDialog(ref) {
  openInputDialog({
    title: 'Bind Table',
    label: 'Lark Base URL',
    placeholder: 'https://my.feishu.cn/base/...?table=...&view=...',
    confirmText: 'Bind',
    onConfirm: async (url) => {
      const result = await startOperation(`/api/skills/${encoded(ref)}/bind`, { url }, 'POST');
      location.hash = `templates/${encoded(result.template.template_id)}`;
    },
  });
}

/**
 * Run 前的确认弹框：先跑一次 dry-run 预览（不执行、不回写、不落 Run），把「会影响多少行」
 * 摆出来再让用户决定；`All Rows` 勾选也放在这里，切换即重新预览，数字始终对应真正要提交的那次。
 * 返回创建出来的 Run；取消（或失败后关闭）返回 undefined。
 */
function openRunDialog({ templateId, target = null }) {
  return new Promise((resolve) => {
    const dialog = h('dialog', { className: 'modal' });
    const allRows = h('input', { type: 'checkbox' });
    const allRowsField = h('label', { className: 'run-option modal-actions-option' }, [
      allRows,
      h('span', { textContent: 'All Rows' }),
    ]);
    // 四个字段一直在，没加载出来的值就是「—」；Lark Base URL 排首位，且只填一次
    // （它跟 trigger 无关，勾选 All Rows 重新预览时不必反复刷新）。
    const valueSpan = (text) => h('span', { className: 'modal-value', textContent: text });
    const field = (label, node) => h('div', { className: 'modal-field' }, [
      h('span', { textContent: label }),
      node,
    ]);
    // 不截断：链接整段换行显示（页码页脚那种「…」在弹框里读不出信息）。
    const urlValue = h('span', { className: 'modal-value' });
    urlValue.replaceChildren(target ? larkBaseLink(target) : '—');
    const triggerValue = valueSpan('—');
    const totalValue = valueSpan('—');
    const selectedValue = valueSpan('—');
    const summary = h('div', { className: 'modal-summary' }, [
      field('Lark Base URL', urlValue),
      field('Trigger', triggerValue),
      field('Rows in table', totalValue),
      field('Rows to process', selectedValue),
    ]);
    const error = h('p', { className: 'modal-error' });
    const cancel = textButton('Cancel');
    const submit = textButton('Execute', 'button primary');
    const trigger = () => (allRows.checked ? 'all' : 'incremental');
    let answered = false;
    let busy = false;
    let sequence = 0;
    let urlFilled = false;

    const finish = (value) => {
      if (answered) return;
      answered = true;
      resolve(value);
      dialog.close();
    };

    const preview = async () => {
      const mine = ++sequence;
      submit.disabled = true;
      error.textContent = '';
      triggerValue.textContent = '—';
      totalValue.textContent = '—';
      selectedValue.textContent = '—';
      try {
        const data = await api(`/api/templates/${encoded(templateId)}/preview`, {
          method: 'POST',
          body: { trigger: trigger() },
        });
        if (mine !== sequence || answered) return;
        triggerValue.textContent = triggerLabel(data.trigger);
        totalValue.textContent = String(data.total);
        selectedValue.textContent = String(data.selected);
        if (!urlFilled && !target) {
          urlValue.replaceChildren(larkBaseLink(data.target));
          urlFilled = true;
        }
        submit.disabled = data.selected === 0;
      } catch (err) {
        if (mine !== sequence || answered) return;
        error.textContent = err.message;
      }
    };

    allRows.addEventListener('change', () => { void preview(); });
    cancel.addEventListener('click', () => finish(undefined));
    submit.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      error.textContent = '';
      submit.disabled = true;
      cancel.disabled = true;
      submit.replaceChildren(icon('spinner', 'icon spinner'), h('span', { textContent: 'Starting…' }));
      try {
        const run = await api('/api/runs', {
          method: 'POST',
          body: { template_id: templateId, trigger: trigger() },
        });
        finish(run);
      } catch (err) {
        error.textContent = err.message;
        busy = false;
        cancel.disabled = false;
        submit.replaceChildren(h('span', { textContent: 'Execute' }));
        submit.disabled = false;
      }
    });
    // Esc 与右上角 ✕ 都算放弃。
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(undefined); });
    dialog.addEventListener('close', () => { if (!answered) { answered = true; resolve(undefined); } dialog.remove(); });

    dialog.append(
      h('div', { className: 'modal-head' }, [
        h('h2', { textContent: 'Execute Template' }),
        h('button', { className: 'icon-button', type: 'button', 'aria-label': 'Close', onClick: () => finish(undefined) }, icon('close')),
      ]),
      h('div', { className: 'modal-form' }, [
        summary,
        error,
        // 勾选框靠左下角，按钮靠右下角（`.modal-actions-option` 负责撑开）。
        h('div', { className: 'modal-actions' }, [allRowsField, cancel, submit]),
      ]),
    );
    document.body.append(dialog);
    dialog.showModal();
    // 首屏（四个「—」）就量好高度并冻住：之后无论加载中还是加载完，弹框高度都不变。
    summary.style.minHeight = `${summary.offsetHeight}px`;
    void preview();
  });
}

export {
  openLoadDialog,
  openMappingDialog,
  openRunDialog,
  openConfirmDialog,
  openAlertDialog,
};
