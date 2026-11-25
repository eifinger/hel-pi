import { api, post, el, button, commandId, confirmAction, feedback } from './ui.js';
import { screen, entry, heading, empty, run, visible, when } from './workspace.js';
import { markdown } from './markdown.js';

let requestId, creating;
const active = g => ['running', 'stopping'].includes(g.status);
function generate() {
  requestId ??= commandId();
  return creating ??= post('posts/generations', {requestId}).then(g => {
    requestId = null; return g;
  }).finally(() => { creating = null; });
}
export function openPosts() {
  const show = screen('posts');
  function list(previous) { return show(async (body, notice) => {
    let timer, seq = 0, cursor, generationId;
    const rows = el('div', 'entry-list card'), noPosts = empty('No posts yet', 'Generate a post to see whether Hel-Pi has an update to share.');
    const generateButton = button('Generate post', () => run(notice, async () => {
      try { update(await generate()); }
      catch (error) { if (error.status !== 409 || !await load()) throw error; }
    }), 'primary');
    const stop = button('Stop generation', () => run(notice, async () => {
      clearTimeout(timer); seq++; update(await post(`posts/generations/${encodeURIComponent(generationId)}/stop`, {}));
    }));
    const state = el('p', 'feedback'); state.setAttribute('role', 'status');
    const retry = button('Check generation', () => poll());
    const more = button('Older posts', () => run(notice, () => load(cursor)));
    async function load(before) {
      const page = await api(`posts${before ? `?before=${encodeURIComponent(before)}` : ''}`);
      if (!before) rows.replaceChildren();
      for (const p of page.posts) rows.append(entry(p.title, p.excerpt, () => read(p.id), new Date(p.createdAt).toLocaleDateString()));
      cursor = page.nextBefore; more.hidden = !cursor; noPosts.hidden = !!rows.childElementCount;
      if (!before && page.activeGeneration) update(page.activeGeneration);
      return page.activeGeneration;
    }
    async function poll() {
      if (!visible(body) || !generationId) return;
      const version = ++seq, id = generationId; retry.hidden = true;
      try {
        const g = await api(`posts/generations/${encodeURIComponent(id)}`);
        if (version === seq && id === generationId) update(g);
      } catch (error) {
        if (!visible(body) || version !== seq) return;
        if (error.status === 404) { generationId = null; generateButton.hidden = false; stop.hidden = true; }
        feedback(state, error.message, true); retry.hidden = !generationId;
      }
    }
    function update(g) {
      if (!visible(body)) return;
      clearTimeout(timer); generationId = active(g) ? g.id : null; retry.hidden = true;
      generateButton.hidden = active(g); stop.hidden = !active(g); stop.disabled = g.status === 'stopping';
      const labels = { running:'Writing a post…', stopping:'Stopping generation…', completed:'Post published.', skipped:'No new post this time.', failed:'Generation failed.', stopped:'Generation stopped.' };
      feedback(state, [labels[g.status], g.reason].filter(Boolean).join(' '), g.status === 'failed');
      if (active(g)) { retry.hidden = false; timer = setTimeout(poll, 1800); }
      else if (g.status === 'completed') load().catch(e => feedback(notice, e.message, true));
    }
    stop.hidden = retry.hidden = more.hidden = noPosts.hidden = true;
    body.append(heading('Published posts', retry, stop, generateButton), state, rows, noPosts, more);
    generateButton.hidden = true;
    await load();
    if (creating) update(await creating);
    else if (!generationId) { generateButton.hidden = false; if (previous) feedback(state, previous); }
  }); }
  function read(id) { return show(async (body, notice) => {
    const path = `posts/${encodeURIComponent(id)}`; body.append(button('← All posts', () => list(), 'back-link'));
    const p = await api(path), card = el('article', 'work-card card');
    card.append(el('p', 'kicker', when(p.createdAt)), el('h2', 'work-title', p.title), markdown(p.body));
    if (p.reason) card.append(el('p', 'muted', `Why this post · ${p.reason}`));
    body.append(card, button('Delete post', () => run(notice, async () => {
      if (!await confirmAction('Delete post?', `Permanently remove “${p.title}”?`, 'Delete post')) return;
      await api(path, {method:'DELETE'}); await list('Post deleted.');
    }), 'secondary danger'));
  }); }
  return list();
}
