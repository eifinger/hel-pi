import { $, el, api, post, field, button, feedback, confirmAction } from './ui.js';
import { screen, actions, heading, empty, run, when } from './workspace.js';
import { markdown } from './markdown.js';
import { openMemories } from './memories.js';
import { wikiFile, resolveLink, validPart } from './wiki-path.js';
export { wikiFile };

const parent = path => path.slice(0, path.lastIndexOf('/'));
const name = path => path.split('/').at(-1);
const get = path => api(`workspace?path=${encodeURIComponent(path)}`);

// Read metadata for display only. The editor gets the entire source document.
function readingCopy(doc) {
  const header = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(doc.text);
  const body = (header ? doc.text.slice(header[0].length) : doc.text).trimStart();
  const h1 = /^#\s+([^\n]+)(?:\n|$)/.exec(body);
  const meta = Object.fromEntries([...(header?.[1] || '').matchAll(/^(title|description|type):[ \t]*(.+)$/gm)]
    .map(([, key, value]) => [key, value.trim().replace(/^(['"])(.*)\1$/, '$2')]));
  return {title:h1?.[1].trim() || meta.title || name(doc.path).replace(/\.md$/i, ''), description:meta.description,
    type:meta.type || 'Wiki page', text:h1 ? body.slice(h1[0].length) : body};
}

async function reviewNotice(slot, notice) {
  let review;
  try { review = await api('wiki-review'); }
  catch { slot.hidden = false; slot.append(el('p', '', 'Could not check automatic review status. Refresh to try again.')); return; }
  if (!review.blocked) return;
  slot.hidden = false;
  slot.append(el('h3', '', 'Automatic wiki review paused'), el('p', '', 'A review stopped before Hel-Pi could confirm its file changes. Check your pages before skipping the batch.'));
  const { batch, messages, boundary } = review;
  function acknowledge(label, title, detail, accept, data, success) {
    slot.append(button(label, async () => {
      if (!await confirmAction(title, detail, accept)) return;
      run(notice, async () => { await post('wiki-review', data); slot.remove(); feedback(notice, success); });
    }));
  }
  if (!batch) {
    const { throughEntryId, token, pinnedAt } = boundary;
    const label = `Skip through entry ${throughEntryId}`;
    slot.append(el('strong', '', 'Original batch unknown'), el('p', '', `The batch record is unavailable. You can skip all pending main-chat entries through ${throughEntryId}, the boundary saved ${when(pinnedAt)}. This may skip messages newer than the interrupted batch.`));
    acknowledge(label+'…', label+'?', `This skips wiki review for every pending message through main-chat entry ${throughEntryId}, not just the interrupted batch. No writes will be retried or undone. Messages after this entry remain eligible.`, label,
      { action:'skip-through', throughEntryId, token }, `Skipped through entry ${throughEntryId}. Messages after this entry can still be reviewed.`);
    return;
  }
  const details = el('details'), transcript = el('div', 'wiki-review-messages');
  const range = `${batch.fromEntryId ? `after entry ${batch.fromEntryId}` : 'from the start'} through entry ${batch.throughEntryId}`;
  details.append(el('summary', '', `Inspect batch · ${when(batch.requestedAt)}`), el('p', 'muted', `Main chat ${range}.`), transcript);
  for (const message of messages) transcript.append(el('p', '', `${message.role === 'user' ? 'You' : 'Hel-Pi'}: ${message.content}`));
  if (!messages.length) transcript.append(el('p', '', 'No readable messages remain in this range.'));
  slot.append(details);
  acknowledge('Skip this batch…', 'Skip this wiki batch?', `Skip wiki review of main-chat messages ${range}? Hel-Pi won’t retry or undo any edits. Newer messages stay queued for review.`, 'Acknowledge and skip',
    { action:'skip', taskId:batch.taskId }, 'Batch skipped. Automatic review can continue with newer messages.');
}

function openWiki(initial) {
  const show = screen('wiki');
  function browse(dir = 'wiki', file) { return show(async (body, notice) => {
    body.append(heading(dir === 'wiki' ? 'Household wiki' : name(dir), button('Refresh', () => browse(dir, file)), button('New page', () => edit(dir), 'primary')));
    const review = el('section', 'work-card card wiki-review'); review.hidden = true; body.append(review);
    if (dir !== 'wiki') body.append(button('↑ Parent folder', () => browse(parent(dir)), 'back-link'));
    const [{ entries }] = await Promise.all([get(dir), reviewNotice(review, notice)]);
    const items = entries.filter(item => parent(item.path) === dir && validPart(name(item.path)) && (item.kind === 'directory' || wikiFile(item.path)));
    file ??= items.find(item => item.name === 'index.md')?.path;
    const grid = el('div', 'wiki-grid'), index = el('div', 'tool-index card'), reader = el('article', 'work-card card wiki-reader');
    if (!items.length && !file) {
      body.append(empty(dir === 'wiki' ? 'Your wiki starts here' : 'This folder is empty', 'Create a Markdown page for a household topic, or let Hel-Pi add what it learns.')); return;
    }
    index.append(el('h3', 'group-name', dir === 'wiki' ? 'Topics' : dir));
    for (const item of items) {
      const folder = item.kind === 'directory';
      const control = button('', () => folder ? browse(item.path) : browse(dir, item.path), 'tool-item');
      control.append(el('strong', '', folder ? `${item.name} ›` : item.name), el('small', '', folder ? 'Topic folder' : 'Wiki page'));
      control.setAttribute('aria-pressed', String(item.path === file)); index.append(control);
    }
    grid.append(index, reader); body.append(grid);
    if (!file) { reader.append(el('h2', '', 'Browse topics'), el('p', 'muted', 'Choose a folder or page to start reading.')); return; }
    const doc = await get(file);
    const copy = readingCopy(doc);
    reader.append(el('p', 'kicker', copy.type), heading(copy.title, button('Edit page', () => edit(dir, doc))));
    if (copy.description) reader.append(el('p', 'muted', copy.description));
    const text = markdown(copy.text, {internalLink(label, target) {
      const path = resolveLink(file, target); if (!path) return;
      const link = el('a', '', label); link.href = `?wiki=${encodeURIComponent(path)}`;
      link.onclick = e => { if (!e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) { e.preventDefault(); browse(parent(path), path); } };
      return link;
    }});
    if (copy.text.trim()) reader.append(text);
    else if (!doc.text.trim()) reader.append(el('p', 'muted', 'This page has no text yet.'));
  }); }

  function edit(dir, doc) { return show((body, notice) => {
    const form = el('form', 'work-card card'), path = el('input'), input = el('textarea');
    const initialPath = doc?.path.slice(5) ?? (dir === 'wiki' ? '' : dir.slice(5) + '/');
    path.value = initialPath; path.placeholder = 'topics/lighting.md'; path.required = true; path.readOnly = !!doc;
    input.value = doc?.text || ''; input.rows = 13;
    async function leave(target) {
      if (target && !wikiFile(target)) return feedback(notice, 'Choose a wiki-relative Markdown page.', true);
      if ((input.value !== (doc?.text || '') || path.value !== initialPath) && !await confirmAction('Discard unsaved changes?', 'Your draft will be replaced by the saved wiki.', 'Discard draft')) return;
      browse(parent(target || `${dir}/_`), target);
    }
    let conflictedPath;
    const reload = button('Load saved page', () => leave(conflictedPath)); reload.hidden = true;
    form.append(el('h2', '', doc ? 'Edit wiki page' : 'Create a wiki page'), field('Page path', path, 'Relative to wiki/. For example: topics/lighting.md'), field('Markdown', input),
      actions(el('button', 'primary', 'Save page'), button('Cancel', () => leave(doc?.path)), reload));
    form.onsubmit = e => {
      e.preventDefault(); const target = `wiki/${path.value.trim()}`;
      if (!wikiFile(target)) return feedback(notice, 'Use a wiki-relative .md path with no hidden or parent folders.', true);
      run(notice, async () => {
        try {
          const saved = await post('workspace', { path: target, text: input.value, revision: doc?.revision ?? 'missing' });
          await browse(parent(saved.path), saved.path);
        } catch (error) {
          if (error.status !== 409 && error.status !== 412) throw error;
          conflictedPath = target; reload.hidden = false; feedback(notice, 'The saved page has changed. Your draft is still here. Copy your changes before loading the saved page.', true);
        }
      });
    };
    body.append(form); (doc ? input : path).focus();
  }); }
  return initial && wikiFile(initial) ? browse(parent(initial), initial) : browse();
}

export function memoryView(wiki = true, initial) {
  $('wiki-body').hidden = !wiki; $('memories-body').hidden = wiki;
  $('wiki-tab').setAttribute('aria-pressed', String(wiki)); $('notes-tab').setAttribute('aria-pressed', String(!wiki));
  // Switching tabs must not discard unsaved Markdown or instruction edits.
  if (wiki && (!$('wiki-body').childElementCount || initial)) openWiki(initial);
  if (!wiki && !$('memories-body').childElementCount) openMemories();
}
$('wiki-tab').onclick = () => memoryView(); $('notes-tab').onclick = () => memoryView(false);
