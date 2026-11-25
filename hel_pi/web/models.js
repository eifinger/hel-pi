import { api, el, field, button, feedback } from './ui.js';
import { screen, actions, select, run } from './workspace.js';

export function openModels() {
  const show = screen('models');
  function settings(snapshot, message) { return show(async (body, notice) => {
    const s = snapshot || await api('settings'), models = [...s.availableModels];
    // A stored selection may be temporarily unavailable. Don't silently replace it on save.
    for (const value of [s.mainModel, s.backgroundModel]) {
      if (value && !models.some(m => m.provider === value.provider && m.id === value.model)) models.push({provider:value.provider, id:value.model, name:`${value.model} (unavailable)`, thinkingLevels:value.thinking ? [value.thinking] : []});
    }
    const index = value => value ? String(models.findIndex(m => m.provider === value.provider && m.id === value.model)) : '';
    const choices = models.map((m, i) => [String(i), `${m.name} · ${m.provider}`]);
    const main = select([['', 'No model selected'], ...choices], index(s.mainModel));
    const bg = select([['', 'Follow conversation model'], ...choices], index(s.backgroundModel));
    const mainThinking = el('select'), bgThinking = el('select');
    function levels(input, model, value, hint) {
      input.replaceChildren(new Option(hint, ''));
      for (const level of new Set([...(model?.thinkingLevels || []), ...(value ? [value] : [])])) input.add(new Option(level, level));
      input.value = value || ''; input.disabled = input.length === 1;
    }
    const effectiveMain = () => models[main.value];
    function background(level) { levels(bgThinking, bg.value === '' ? effectiveMain() : models[bg.value], level, bg.value === '' ? 'Follow conversation thinking' : 'Model default'); }
    function primary(level) { levels(mainThinking, main.value === '' ? null : models[main.value], level, 'Model default'); }
    primary(s.mainModel?.thinking); background(s.backgroundModel?.thinking || s.backgroundThinking);
    main.onchange = () => { primary(); if (bg.value === '') background(effectiveMain()?.thinkingLevels.includes(bgThinking.value) ? bgThinking.value : ''); };
    bg.onchange = () => background();
    const form = el('form', 'work-card card');
    function role(title, copy, model, thinking) {
      const block = el('section', 'work-stack'), inputs = el('div', 'field-grid');
      inputs.append(field(`${title} model`, model), field(`${title} thinking`, thinking));
      block.append(el('h2', '', title), el('p', 'muted', copy), inputs); return block;
    }
    form.append(role('Conversation', 'Used for the main chat and new conversations.', main, mainThinking), role('Background', 'Used for tasks, curation, and other background work.', bg, bgThinking),
      actions(el('button', 'primary', 'Save settings'), button('Reload settings', () => settings())));
    const current = s.currentModel;
    body.append(el('p', 'muted', current ? `Currently in use: ${current.provider} / ${current.model}${current.thinking ? ` · ${current.thinking} thinking` : ''}` : 'No current model.'), form);
    if (message) feedback(notice, message);
    function selection(input, thinking) {
      if (input.value === '') return null;
      const m = models[input.value]; return {provider:m.provider, model:m.id, ...(thinking.value && {thinking:thinking.value})};
    }
    form.onsubmit = e => { e.preventDefault(); run(notice, async () => {
      const data = {baseRevision:s.revision, mainModel:selection(main, mainThinking), backgroundModel:selection(bg, bgThinking), backgroundThinking:bg.value === '' ? bgThinking.value || null : null};
      try {
        const result = await api('settings', {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)});
        await settings(result.snapshot, `Settings saved.${result.pendingConversations ? ` Conversations awaiting the change: ${result.pendingConversations}.` : ''}`);
      } catch (error) {
        if (error.status !== 409) throw error;
        feedback(notice, 'Settings changed elsewhere. Reload settings and review your choices before saving.', true);
      }
    }); };
  }); }
  return settings();
}
