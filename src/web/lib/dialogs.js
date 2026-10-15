import { startOperation } from './api.js';
import { h, icon, textButton } from './dom.js';
import { encoded } from './format.js';

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
      const result = await startOperation('/api/skills/load', { source_path: sourcePath }, 'POST');
      location.hash = `skills/${encoded(result.ref)}`;
    },
  });
}

/** 只反馈信息的弹框：标题 + 若干「字段 / 值」；说明放在底部与按钮同一行的左侧。 */
function openMessageDialog({ title, rows = [], hint = '' }) {
  const dialog = h('dialog', { className: 'modal' });
  const close = textButton('OK', 'button primary');
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove());
  dialog.append(
    h('div', { className: 'modal-head' }, [
      h('h2', { textContent: title }),
      h('button', { className: 'icon-button', type: 'button', 'aria-label': 'Close', onClick: () => dialog.close() }, icon('close')),
    ]),
    h('div', { className: 'modal-form' }, [
      ...rows.map(([label, value]) => h('div', { className: 'modal-field' }, [
        h('span', { textContent: label }),
        h('span', { className: 'modal-value' }, value),
      ])),
      h('div', { className: 'modal-actions' }, [
        hint ? h('span', { className: 'modal-hint' }, [icon('info'), h('span', { textContent: hint })]) : null,
        close,
      ]),
    ]),
  );
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

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

function openMappingDialog(ref) {
  openInputDialog({
    title: 'Mapping Table',
    label: 'Feishu Base URL',
    placeholder: 'https://my.feishu.cn/base/...?table=...&view=...',
    confirmText: 'Mapping',
    onConfirm: async (url) => {
      const result = await startOperation('/api/mappings', { ref, url }, 'POST');
      location.hash = `templates/${encoded(result.template.template_id)}`;
    },
  });
}

export {
  openLoadDialog,
  openMappingDialog,
  openMessageDialog,
  openConfirmDialog,
};
