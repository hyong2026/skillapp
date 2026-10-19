import { api, startOperation } from './api.js';
import { h, icon, textButton } from './dom.js';
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

function openLoadDialog() {
  openInputDialog({
    title: 'Load Skill',
    label: 'Skill Source',
    placeholder: '/Users/me/skills/my-skill',
    confirmText: 'Load',
    onConfirm: async (sourcePath) => {
      const result = await startOperation('/api/skills', { source_path: sourcePath }, 'POST');
      location.hash = `skills/${encoded(result.ref)}`;
    },
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
