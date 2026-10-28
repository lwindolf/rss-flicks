// Generic action pattern: any element with data-action="name" triggers the
// handler registered under that name, wherever the element lives in the DOM.
// An optional data-busy-label is shown on all buttons of an action while an
// async handler is running.

const handlers = new Map();

export function registerAction(name, handler) {
  handlers.set(name, handler);
}

function setBusy(name, busy) {
  document.querySelectorAll(`button[data-action="${name}"]`).forEach((button) => {
    button.disabled = busy;
    if (!button.dataset.busyLabel) return;
    if (busy) {
      button.dataset.label = button.textContent;
      button.textContent = button.dataset.busyLabel;
    } else if (button.dataset.label) {
      button.textContent = button.dataset.label;
    }
  });
}

export function initActions() {
  document.addEventListener('click', async (event) => {
    const target = event.target.closest?.('[data-action]');
    const handler = target && handlers.get(target.dataset.action);
    if (!handler || target.disabled) return;

    const name = target.dataset.action;
    setBusy(name, true);
    try {
      await handler(target, event);
    } finally {
      setBusy(name, false);
    }
  });
}
