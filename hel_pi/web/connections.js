import { el, button, field, status, feedback, loadCatalog, post, confirmAction } from './ui.js';

function password() {
  const input = el('input'); input.type = 'password'; input.autocomplete = 'new-password'; input.spellcheck = false;
  return input;
}
function select(options) {
  const node = el('select');
  for (const [value, label] of options) { const opt = el('option', '', label); opt.value = value; node.append(opt); }
  return node;
}

export function openConnections() {
  return loadCatalog('connections-body', (page, tools, initial) => {
    let connections = initial;
    const heading = el('div', 'services-heading'), title = el('h2', '', 'Service connections'), count = el('span', 'count', connections.length);
    title.append(count);
    const add = button('+ Add connection', () => { form.hidden = !form.hidden; add.setAttribute('aria-expanded', String(!form.hidden)); if (!form.hidden) name.focus(); });
    add.setAttribute('aria-expanded', 'false'); heading.append(title, add);
    const form = el('form', 'connection-form card'); form.hidden = true;
    const name = el('input'), kind = select([['http', 'HTTP · GET'], ['mcp', 'MCP']]), url = el('input'),
      auth = select([['Authorization', 'Authorization (Bearer)'], ['X-API-Key', 'X-API-Key']]), secret = password();
    name.required = url.required = true; url.type = 'url'; url.spellcheck = false; url.placeholder = 'https://service.example/v1';
    const note = status(), endpoint = field('Base URL', url, 'Requests use GET within this origin or path prefix.');
    function changeKind() {
      const mcp = kind.value === 'mcp'; auth.disabled = mcp; if (mcp) auth.value = 'Authorization';
      endpoint.firstChild.textContent = mcp ? 'MCP endpoint' : 'Base URL';
      endpoint.lastChild.textContent = mcp ? 'Enter the URL of the MCP server.' : 'Requests use GET within this origin or path prefix.';
    }
    kind.onchange = changeKind;
    const fields = el('div', 'field-grid'); fields.append(field('Connection name', name), field('Type', kind), endpoint, field('Authentication header', auth), field('Secret (optional)', secret, 'Write-only. Stored credentials cannot be viewed here.'));
    const save = el('button', 'primary', 'Create connection'); save.type = 'submit';
    function closeForm() { form.reset(); changeKind(); form.hidden = true; add.setAttribute('aria-expanded', 'false'); feedback(note, ''); }
    const buttons = el('div', 'actions'); buttons.append(save, button('Cancel', () => { closeForm(); add.focus(); }, 'quiet'));
    form.append(el('h3', '', 'New connection'), fields, buttons, note);
    const list = el('div', 'service-list'), message = status(), group = el('fieldset', 'services');
    group.setAttribute('aria-label', 'Service connections'); group.append(heading, form, message, list); page.append(group);
    async function update(body, messageBox, complete) {
      if (group.disabled) return;
      group.disabled = true; feedback(messageBox, 'Saving…');
      try {
        const result = await post('connections', body); connections = result.connections;
        feedback(messageBox, ''); complete(); count.textContent = connections.length;
      } catch (error) { feedback(messageBox, error.message, true); }
      finally { group.disabled = false; }
    }
    form.onsubmit = event => {
      event.preventDefault(); const previous = new Set(connections.map(c => c.id));
      const data = { action: 'create', name: name.value.trim(), kind: kind.value, url: url.value.trim(), authHeader: auth.value };
      if (secret.value) data.secret = secret.value;
      update(data, note, () => { closeForm(); draw(connections.find(c => !previous.has(c.id))?.id); feedback(message, 'Connection created.'); });
    };
    function draw(openId) {
      list.replaceChildren();
      if (!connections.length) list.append(el('p', 'empty-panel card', 'No services connected. Add an HTTP or MCP connection to get started.'));
      for (const c of connections) {
        const card = el('details', 'service card'); card.open = openId === c.id;
        const head = el('summary', 'service-summary'), info = el('span', 'service-info');
        const tag = el('span', 'service-kind', c.kind === 'mcp' ? 'MCP' : 'GET');
        info.append(el('strong', '', c.name), el('small', 'endpoint', c.url));
        head.append(tag, info, el('span', 'pill service-status', c.status || 'Untested'), el('span', 'chevron', '›'));
        card.append(head); list.append(card);
        const content = el('div', 'service-body'), notice = status(), actions = el('div', 'actions'); card.append(content);
        function act(action, success, extra = {}) {
          feedback(message, '');
          return update({ id: c.id, action, ...extra }, notice, () => { draw(c.id); feedback(message, `${c.name}: ${success}`); });
        }
        actions.append(button('Test connection', () => act('test', 'test complete.')));
        if (c.kind === 'mcp') actions.append(button('Discover tools', () => act('discover', 'catalog refreshed.')));
        const dependencies = tools.local.flatMap(tool => {
          const revisions = ['active', 'draft'].filter(k => tool[k]?.connectionId === c.id)
            .map(k => `${k === 'active' && tool.enabled === false ? 'disabled' : k} r${tool[k].revision}`);
          return revisions.length ? [`${tool.name} (${revisions.join(', ')})`] : [];
        });
        const deps = el('p', 'dependent', 'Dependent local tools: '); deps.append(el('strong', '', dependencies.join('; ') || 'None'));
        content.append(deps);
        const credential = el('details', 'credential'), secForm = el('form', 'secret-form'), replacement = password(); replacement.required = true;
        credential.append(el('summary', '', `${c.authHeader} · ${c.hasSecret ? '•••••••• (stored)' : 'No secret stored'}`));
        const set = el('button', 'secondary', c.hasSecret ? 'Replace secret' : 'Save secret'); set.type = 'submit';
        const secretActions = el('div', 'actions'); secretActions.append(set);
        if (c.hasSecret) secretActions.append(button('Clear secret', async () => {
          if (await confirmAction(`Clear the credential for ${c.name}?`, 'Future requests will not include a credential.', 'Clear secret')) act('secret', 'credential cleared.', { secret: '' });
        }, 'quiet danger'));
        secForm.append(field('New secret', replacement, 'Write-only. Leave the stored value as-is unless you want to replace it.'), secretActions);
        secForm.onsubmit = event => { event.preventDefault(); if (replacement.value) act('secret', 'credential saved.', { secret: replacement.value }); };
        credential.append(secForm); content.append(credential);
        if (c.kind === 'mcp') {
          const catalog = el('div', 'mcp-tools'); catalog.append(el('h3', 'subhead', 'Allowed MCP tools'));
          const names = new Set([...c.catalog.map(t => t.name), ...c.allowed]);
          if (!names.size) catalog.append(el('p', 'muted', 'Discover tools to choose which ones Hel-Pi can use.'));
          for (const name of names) {
            const item = c.catalog.find(t => t.name === name), label = el('label', 'mcp-row'), copy = el('span'), toggle = el('input');
            toggle.type = 'checkbox'; toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-label', `Allow ${name}`); toggle.checked = c.allowed.includes(name);
            toggle.onchange = () => {
              const allowed = toggle.checked;
              // Keep the last confirmed state visible until the server accepts this change.
              toggle.checked = c.allowed.includes(name); act('allow', 'tool access updated.', {name, allowed});
            };
            copy.append(el('strong', '', name)); if (item?.description) copy.append(el('small', 'muted', item.description));
            label.append(copy, toggle); catalog.append(label);
          }
          content.append(catalog);
        }
        actions.append(button('Delete', async () => {
          const detail = dependencies.length ? `Dependent tools: ${dependencies.join('; ')}. These revisions will lose their connection.` : 'This removes the connection and its stored credential.';
          if (await confirmAction(`Delete ${c.name}?`, detail, 'Delete connection')) act('delete', 'connection deleted.');
        }, 'quiet danger'));
        content.append(actions, notice);
      }
    }
    draw();
  });
}
