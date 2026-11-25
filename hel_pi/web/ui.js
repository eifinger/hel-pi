export const $ = id => document.getElementById(id);
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
export function button(text, action, style = 'secondary') {
  const node = el('button', style, text);
  node.type = 'button'; node.onclick = action;
  return node;
}
export function field(label, input, help) {
  const wrap = el('label', 'field');
  wrap.append(el('span', '', label), input);
  if (help) wrap.append(el('small', 'muted', help));
  return wrap;
}
export function status() {
  const box = el('p', 'feedback'); box.setAttribute('role', 'status');
  return box;
}
export function feedback(box, message, failed = false) {
  box.textContent = message; box.classList.toggle('error', failed);
}

// Native HTML dialogs stay inside the ingress frame (browser confirm() can
// be suppressed there) and return focus to the control that opened them.
export function confirmAction(title, detail, accept) {
  const dialog = el('dialog', 'confirm-dialog'), heading = el('h2', '', title), actions = el('div', 'actions');
  dialog.setAttribute('aria-label', title);
  const cancel = button('Cancel', () => dialog.close()); cancel.autofocus = true;
  actions.append(cancel, button(accept, () => dialog.close('yes'), 'primary'));
  dialog.append(heading, el('p', '', detail), actions); document.body.append(dialog);
  return new Promise(resolve => {
    dialog.addEventListener('close', () => { dialog.remove(); resolve(dialog.returnValue === 'yes'); }, { once: true });
    dialog.showModal();
  });
}

// Relative to the document's base: Home Assistant may prepend an ingress path.
export async function api(path, options = {}) {
  const response = await fetch(`api/${path}`, { credentials: 'same-origin', cache: 'no-store', ...options });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || data.error) {
    throw Object.assign(new Error(data?.error || `Hel-Pi did not return a usable response (${response.status}).`), {
      status: response.status, code: data?.code,
    });
  }
  return data;
}
export const post = (path, data) => api(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
});

// getRandomValues, unlike randomUUID, is also available on LAN HTTP origins.
export const commandId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');

// A new page owns a new container. A slow response for a previous visit can
// only update detached DOM, never a different tool or revision on screen.
export async function loadCatalog(target, render) {
  const page = el('div'), notice = status();
  $(target).replaceChildren(page); page.append(notice);
  async function load() {
    feedback(notice, 'Loading…'); page.replaceChildren(notice);
    try {
      const [tools, { connections }] = await Promise.all([api('tools'), api('connections')]);
      if (page.isConnected) { page.replaceChildren(); render(page, tools, connections); }
    } catch (error) {
      feedback(notice, error.message, true); page.append(button('Try again', load));
    }
  }
  await load();
}
