import { $, el, button, status, feedback } from './ui.js';

// Each visit, including a detail within a page, gets a separate DOM owner. Late
// reads can only populate detached elements; writes never navigate another view.
export function screen(view) {
  const host = el('div'); $(`${view}-body`).replaceChildren(host);
  return async function show(render) {
    if (!host.isConnected) return;
    if (visible(host)) $('main').scrollTop = 0;
    const pane = el('fieldset', 'workspace-pane'), notice = status();
    const content = el('div', 'work-stack'); host.replaceChildren(pane);
    pane.append(notice, content); feedback(notice, 'Loading…');
    try { await render(content, notice); if (notice.textContent === 'Loading…') feedback(notice, ''); }
    catch (error) { feedback(notice, error.message, true); content.append(button('Try again', () => show(render))); }
  };
}
export const visible = node => node.isConnected && !node.closest('[hidden]');
export const when = at => new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export function actions(...nodes) { const box = el('div', 'actions'); box.append(...nodes); return box; }
export function heading(title, ...controls) {
  const bar = el('div', 'work-heading'); bar.append(el('h2', '', title), actions(...controls)); return bar;
}
export function entry(title, detail, onOpen, tag) {
  const item = button('', onOpen, 'entry');
  const copy = el('span', 'entry-copy'); copy.append(el('strong', '', title));
  if (detail) copy.append(el('small', 'muted', detail));
  item.append(copy); if (tag) item.append(el('span', 'pill', tag));
  const arrow = el('span', 'chevron', '›'); arrow.ariaHidden = 'true'; item.append(arrow); return item;
}
export function empty(title, copy) {
  const box = el('div', 'work-empty card'); box.append(el('h2', '', title), el('p', 'muted', copy)); return box;
}
export function select(choices, value) {
  const input = el('select');
  for (const [id, title] of choices) input.add(new Option(title, id));
  if (value != null) input.value = value;
  return input;
}
export async function run(notice, job) {
  const pane = notice.closest('fieldset');
  if (pane.disabled) return;
  pane.disabled = true; feedback(notice, 'Working…');
  try { await job(); if (notice.textContent === 'Working…') feedback(notice, ''); }
  catch (error) { feedback(notice, error.message, true); }
  finally { pane.disabled = false; }
}
