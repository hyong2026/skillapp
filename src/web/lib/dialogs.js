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

function openMappingDialog(ref) {
  openInputDialog({
    title: 'Mapping',
    label: 'Feishu Base URL',
    placeholder: 'https://my.feishu.cn/base/...?table=...&view=...',
    confirmText: 'Mapping',
    onConfirm: async (url) => {
      const result = await startOperation('/api/mappings', { ref, url }, 'POST');
      location.hash = `templates/${encoded(result.template.template_id)}`;
    },
  });
}

export { openInputDialog, openLoadDialog, openMappingDialog };
