import { api, post, el, button, commandId, status, feedback, confirmAction } from './ui.js';
import { screen, heading, entry, empty, run, visible, when, actions } from './workspace.js';

export function openSideChats(open) {
  const show = screen('side-chats');
  return show(async (body, notice) => {
    const requestId = commandId();
    body.append(heading('Conversations', button('New side chat', () => run(notice, async () => {
      const chat = await post('side-chats', {requestId}); if (visible(body)) open(chat);
    }), 'primary')));
    const chats = await api('side-chats');
    if (!chats.length) { body.append(empty('No side chats yet', 'Start a thread for a specific question, project, or idea.')); return; }
    const list = el('div', 'entry-list card'); body.append(list);
    for (const chat of chats) list.append(entry(chat.title || 'Untitled side chat', `Created ${when(chat.createdAt)}`, () => open(chat)));
  });
}

export function chatActions({chat, path, row, onTitle, onDelete, busy}) {
  const dialog = el('dialog', 'confirm-dialog chat-dialog'); dialog.id = 'chat-actions-dialog'; dialog.setAttribute('aria-label', 'Chat actions');
  const pane = el('fieldset'), search = el('form'), term = el('input'), matches = el('div', 'chat-results'), notice = status();
  term.type = 'search'; term.required = true; term.maxLength = 4096; term.placeholder = 'Search this conversation…'; term.setAttribute('aria-label', 'Search this conversation');
  search.append(term, el('button', 'primary', 'Search'));
  search.onsubmit = e => { e.preventDefault(); run(notice, async () => {
    matches.replaceChildren(); const page = await api(`${path}/search?q=${encodeURIComponent(term.value.trim())}`);
    feedback(notice, page.messages.length ? `${page.messages.length} ${page.messages.length === 1 ? 'match' : 'matches'}${page.truncated ? ' · Refine your search for more.' : ''}` : 'No matching messages.');
    matches.append(...page.messages.map(row));
  }); };
  const compact = button('Compact context', () => run(notice, async () => {
    if (!await confirmAction('Compact this conversation?', 'Summarize older context for the model. Your chat history stays available.', 'Compact context')) return;
    const result = await post(`${path}/compact`, {}); feedback(notice, result.status === 'cancelled' ? 'Compaction cancelled.' : 'Context compacted.');
  })); compact.disabled = busy;
  const controls = actions(compact);
  if (chat) {
    const route = `side-chats/${encodeURIComponent(chat.id)}`;
    controls.append(button('Generate title', () => run(notice, async () => {
      onTitle(await post(`${route}/title/generate`, {})); feedback(notice, 'Chat title updated.');
    })), button('Delete side chat', () => run(notice, async () => {
      if (!await confirmAction('Delete side chat?', 'Permanently remove this conversation and its history?', 'Delete side chat')) return;
      await api(route, {method:'DELETE'}); dialog.close(); onDelete();
    }), 'secondary danger'));
  }
  dialog.append(heading('Chat actions', button('Close', () => dialog.close())), pane); pane.append(search, notice, matches, controls);
  dialog.addEventListener('close', () => dialog.remove(), {once:true}); document.body.append(dialog); dialog.showModal(); term.focus();
}
