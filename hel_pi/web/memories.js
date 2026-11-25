import { $, api, post, el, field, button, status, feedback, confirmAction } from './ui.js';

export async function openMemories() {
  const page = el('div'), notice = status();
  $('memories-body').replaceChildren(page); page.append(notice);
  feedback(notice, 'Loading…');
  let profile;
  try { profile = await api('memory'); }
  catch (error) { feedback(notice, error.message, true); page.append(button('Try again', openMemories)); return; }
  if (!page.isConnected) return;
  const notes = el('fieldset', 'memory-panel card'), picker = el('select'), input = el('textarea');
  const editor = el('form'), heading = el('div', 'services-heading'), title = el('h2'), file = el('code', 'muted');
  const help = el('p', 'muted'), save = el('button', 'primary', 'Save changes');
  notes.setAttribute('aria-label', 'Memory documents'); input.rows = 7;
  let current = profile.longTerm;
  function options(dates) {
    const long = el('option', '', 'Long-term memory'); long.value = 'MEMORY.md';
    const group = el('optgroup'); group.label = 'Daily notes';
    for (const date of dates) { const option = el('option', '', date); option.value = `memory/${date}.md`; group.append(option); }
    picker.replaceChildren(long, group);
  }
  function show(doc) {
    current = doc; picker.value = doc.name; file.textContent = doc.name;
    const long = doc.name === 'MEMORY.md'; title.textContent = long ? 'Long-term memory' : 'Daily note';
    help.textContent = long ? 'Stable facts and preferences. Hel-Pi reads this on every model request in chat.' : 'Dated context. Hel-Pi reads this note only when it needs it.';
    input.value = doc.text; input.placeholder = long ? 'No long-term memory yet. Add a fact here or ask Hel-Pi to remember it.' : 'No notes for this day.';
    input.readOnly = doc.revision === 'oversized';
    if (input.readOnly) { help.textContent = 'Ignored because this file exceeds 64 KiB. Shorten the file in the workspace, then reload.'; input.placeholder = 'File not loaded.'; }
    save.disabled = true;
  }
  async function load(name) {
    picker.value = current.name;
    if (input.value !== current.text && !await confirmAction('Discard unsaved changes?', 'Your draft will be replaced by the saved document.', 'Discard draft')) return;
    notes.disabled = true;
    try {
      const latest = await api('memory');
      const doc = name === 'MEMORY.md' ? latest.longTerm : await api(`memory?date=${encodeURIComponent(name.slice(7,-3))}`);
      options(latest.dates); show(doc); feedback(notice, '');
    } catch (error) { feedback(notice, error.message, true); }
    finally { notes.disabled = false; }
  }
  picker.onchange = () => load(picker.value); input.oninput = () => { save.disabled = input.value === current.text; feedback(notice, ''); };
  editor.onsubmit = async event => {
    event.preventDefault(); if (notes.disabled || save.disabled) return;
    notes.disabled = true;
    try { show(await post('memory', {action:'save', name:current.name, revision:current.revision, text:input.value})); feedback(notice, 'Changes saved.'); }
    catch (error) { feedback(notice, error.message, true); }
    finally { notes.disabled = false; }
  };
  options(profile.dates); show(current); feedback(notice, '');
  heading.append(title, file); editor.append(field('Markdown', input), save, button('Reload', () => load(current.name), 'quiet'), notice);
  notes.append(field('Document', picker), heading, help, editor);

  const panel = el('details', 'memory-panel card'), summary = el('summary'), source = el('span', 'pill');
  summary.append(el('strong', '', 'Assistant instructions'), source);
  const form = el('form'), instructions = el('textarea'), info = status();
  instructions.rows = 4; instructions.maxLength = 8192;
  instructions.readOnly = profile.source === 'ha' || profile.oversized?.includes('AGENTS.md');
  const guidance = profile.source === 'ha' ? 'Managed in Home Assistant → Hel-Pi → Configuration. Clear the option and restart to edit here.' : instructions.readOnly ? 'AGENTS.md exceeds 64 KiB. Shorten it in the workspace to use it instead of the default instructions.' : 'Set how Hel-Pi should respond. Leave blank and save to restore the default. Tool permissions stay the same.';
  function showInstructions() {
    instructions.value = profile.instructions;
    source.textContent = { local: 'Custom', ha: 'Home Assistant', default: 'Default' }[profile.source];
  }
  showInstructions();
  form.append(field('Behavior and style', instructions, guidance));
  const apply = el('button', 'primary', 'Save instructions');
  if (!instructions.readOnly) form.append(apply);
  form.onsubmit = async event => {
    event.preventDefault(); if (instructions.readOnly || apply.disabled) return;
    apply.disabled = instructions.readOnly = true;
    try {
      profile = await post('memory', { action: 'instructions', previous: profile.instructions, instructions: instructions.value });
      showInstructions(); feedback(info, 'Instructions saved.');
    } catch (error) { feedback(info, error.message, true); }
    finally { apply.disabled = instructions.readOnly = false; }
  };
  form.append(info); panel.append(summary, form); page.replaceChildren(notes, panel);
}
