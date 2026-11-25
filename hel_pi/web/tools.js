import { el, button, field, status, feedback, loadCatalog, post, confirmAction } from './ui.js';
import { sourceView } from './source.js';

const kinds = { local: 'Local', builtin: 'Built-in', mcp: 'MCP' };
const pretty = value => JSON.stringify(value, null, 2);
const bound = (id, connections) => connections.find(c => c.id === id)?.name ?? (id ? `Unavailable · ${id}` : 'None');
const approvedLabel = tool => tool.enabled === false ? 'Disabled' : 'Active';
function summary(item, kind) {
  if (kind === 'local') return [item.draft && `Draft r${item.draft.revision}`, item.active && `${approvedLabel(item)} r${item.active.revision}`].filter(Boolean).join(' · ') || 'No revisions';
  return kind === 'builtin' ? 'Available' : `${item.connectionName} · ${item.permitted ? 'Allowed' : 'Not allowed'}`;
}
export function openTools(state = {}) {
  return loadCatalog('tools-body', (page, tools, connections) => {
    const entries = Object.entries(kinds).flatMap(([kind]) => tools[kind].map(item => ({
      kind, item, key: JSON.stringify([kind, item.connectionId, item.name]),
    })));
    let filter = state.filter || 'all', selected = state.key, mobileDetail = !!state.detail;
    const top = el('div', 'library-controls'), search = el('input'), filters = el('div', 'filters');
    search.type = 'search'; search.placeholder = 'Search tools…'; search.setAttribute('aria-label', 'Search tools'); search.value = state.search || '';
    top.append(search, filters);
    for (const [key, label] of Object.entries({ all: 'All tools', ...kinds })) {
      const btn = button(label, () => { filter = key; mobileDetail = false; draw(); }, 'filter'); btn.dataset.kind = key;
      filters.append(btn);
    }
    const grid = el('div', 'tool-grid'), index = el('div', 'tool-index card'), details = el('div', 'tool-details card');
    grid.append(index, details); page.append(top, grid);
    search.oninput = () => { mobileDetail = false; draw(); };
    function draw() {
      const term = search.value.toLowerCase().trim();
      const visible = entries.filter(({ kind, item }) => (filter === 'all' || filter === kind) &&
        [item.name, item.description, item.connectionName, item.draft?.description, item.active?.description, kinds[kind]]
          .some(value => value?.toLowerCase().includes(term)));
      for (const btn of filters.children) btn.setAttribute('aria-pressed', String(btn.dataset.kind === filter));
      const chosen = visible.find(e => e.key === selected) || visible[0]; selected = chosen?.key;
      grid.classList.toggle('inspecting', mobileDetail && !!chosen);
      index.replaceChildren(); details.replaceChildren(); details.hidden = !chosen;
      if (!chosen) { index.append(el('p', 'empty-panel', 'No matching tools. Try another search or category.')); return; }
      for (const [kind, label] of Object.entries(kinds)) {
        const group = visible.filter(e => e.kind === kind); if (!group.length) continue;
        const groupName = el('h2', 'group-name', label); groupName.append(el('span', 'count', group.length)); index.append(groupName);
        for (const entry of group) {
          const btn = button('', () => {
            selected = entry.key; mobileDetail = true; draw();
            details.focus({ preventScroll: true });
          }, 'tool-item');
          btn.setAttribute('aria-pressed', String(selected === entry.key));
          btn.append(el('strong', '', entry.item.name), el('small', '', summary(entry.item, kind))); index.append(btn);
        }
      }
      details.tabIndex = -1;
      details.append(button('← All results', () => { mobileDetail = false; draw(); index.querySelector('[aria-pressed="true"]')?.focus(); }, 'back-link mobile-back'));
      const { kind, item } = chosen;
      details.append(el('p', 'kicker', `${kinds[kind]} tool`), el('h2', 'tool-name', item.name));
      if (kind === 'local' && (item.active || item.draft)) {
        const key = selected;
        review(details, item, connections, () => {
          if (page.isConnected) openTools({ key: selected, detail: mobileDetail && selected === key, search: search.value, filter });
        });
      } else {
        details.append(el('p', 'tool-description', item.description || 'No active or draft revision.'), el('span', 'pill', summary(item, kind)));
        if (item.inputSchema) details.append(el('h3', 'subhead', 'Input schema'), el('pre', 'json-box', pretty(item.inputSchema)));
      }
    }
    draw();
  });
}

function review(host, tool, connections, reload) {
  const tabs = el('div', 'revision-tabs'), panel = el('div'); host.append(tabs, panel);
  const hasBoth = tool.active && tool.draft;
  function display(view) {
    const draft = view !== 'active', compare = view === 'changes', rev = draft ? tool.draft : tool.active;
    panel.replaceChildren(); tabs.replaceChildren();
    for (const [id, label] of [['draft', 'Draft'], ['active', approvedLabel(tool)], ['changes', 'Changes']]) {
      if (id === 'changes' ? !hasBoth : !tool[id]) continue;
      const tab = button(id === 'changes' ? label : `${label} r${tool[id].revision}`, () => display(id), 'revision-tab');
      tab.setAttribute('aria-pressed', String(id === view)); tabs.append(tab);
    }
    panel.append(el('p', 'tool-description', rev.description));
    const binding = el('p', 'binding', 'Connection '), service = connections.find(c => c.id === rev.connectionId);
    binding.append(el('strong', '', bound(rev.connectionId, connections)));
    if (service) binding.append(` · ${service.url}`);
    panel.append(binding);
    const frame = el('div', 'source-frame');
    const heading = el('div', 'source-heading'); heading.append(el('strong', '', compare ? `Changes · r${tool.active.revision} → r${rev.revision}` : 'JavaScript'), el('span', '', 'Read-only'));
    frame.append(heading, sourceView(rev.source, compare ? tool.active.source : undefined)); panel.append(frame);
    if (compare) {
      if (tool.active.source === rev.source) panel.append(el('p', 'muted', 'Source is unchanged.'));
      for (const [key, label] of Object.entries({description: 'Description', connectionId: 'Connection', sampleInput: 'Sample input', sampleFixtures: 'Sample fixtures'})) {
        if (pretty(tool.active[key]) === pretty(rev[key])) continue;
        const change = el('details', 'metadata'), get = obj => key === 'connectionId' ? bound(obj[key], connections) : typeof obj[key] === 'string' ? obj[key] : pretty(obj[key]);
        change.append(el('summary', '', `${label} changed`), el('pre', 'json-box', `${approvedLabel(tool)}: ${get(tool.active)}\nDraft: ${get(rev)}`)); panel.append(change);
      }
    }
    const sample = el('details', 'sample'); sample.append(el('summary', '', `Sample test · r${rev.revision}`));
    const form = el('div', 'sample-form'); sample.append(form); panel.append(sample);
    const editor = (label, value) => {
      const input = el('textarea', 'json-input'); input.value = pretty(value ?? {}); input.rows = 3; input.spellcheck = false;
      form.append(field(label, input)); return input;
    };
    const input = editor('Sample input (JSON)', rev.sampleInput), fixtures = editor('Sample fixtures (JSON)', rev.sampleFixtures);
    const result = el('div', 'sample-result'); result.setAttribute('role', 'status');
    function readObject(editor, label) {
      try { const obj = JSON.parse(editor.value); if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj; } catch { /* below */ }
      throw new Error(`${label} must be a JSON object.`);
    }
    const run = button('Run sample', async () => {
      input.readOnly = fixtures.readOnly = run.disabled = true; result.replaceChildren(el('p', 'muted', 'Testing…'));
      try {
        const response = await post('tools', { name: tool.name, revision: rev.revision, action: 'test', input: readObject(input, 'Input'), fixtures: readObject(fixtures, 'Fixtures') });
        result.replaceChildren(el('h3', 'subhead', `Sample result · r${rev.revision}`), el('pre', 'json-box', pretty(response.result)));
      } catch (error) { result.replaceChildren(el('p', 'error', error.message)); }
      finally { input.readOnly = fixtures.readOnly = run.disabled = false; }
    });
    input.oninput = fixtures.oninput = () => result.replaceChildren();
    form.append(run, result);
    const decisions = el('div', 'review-actions'), message = status();
    const actions = draft ? [['approve', 'Approve draft'], ['reject', 'Reject draft']] : tool.enabled === false ? [['enable', 'Enable tool']] : [['disable', 'Disable tool']];
    for (const [action, label] of actions) {
      const btn = button(label, async () => {
        const detail = action === 'approve' && tool.active && tool.enabled === false ? 'Replace the approved revision. The tool will remain disabled until you enable it.'
          : action === 'approve' || action === 'enable' ? `Hel-Pi will be able to run this revision with the bound connection: ${bound(rev.connectionId, connections)}.`
          : action === 'reject' ? 'Remove this draft without changing the approved revision.' : 'Hel-Pi will no longer be able to run this revision. Its source will remain available for review.';
        if (!await confirmAction(`${label}: ${tool.name} · r${rev.revision}?`, detail, label)) return;
        for (const control of decisions.children) control.disabled = true;
        feedback(message, 'Saving decision…');
        try { await post('tools', { name: tool.name, revision: rev.revision, action }); reload(); }
        catch (error) { feedback(message, error.message, true); for (const control of decisions.children) control.disabled = false; }
      }, action === 'approve' || action === 'enable' ? 'primary' : 'secondary');
      decisions.append(btn);
    }
    panel.append(decisions, message);
  }
  display(tool.draft ? 'draft' : 'active');
}
