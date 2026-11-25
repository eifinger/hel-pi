import { api, post, el, field, button, confirmAction, commandId } from './ui.js';
import { screen, actions, heading, entry, empty, select, when, run } from './workspace.js';
import { markdown } from './markdown.js';

export function openTasks() {
  const show = screen('tasks');
  function list() { return show(async body => {
    body.append(heading('Scheduled work', button('New task', () => editor(), 'primary')));
    const { tasks } = await api('tasks');
    if (!tasks.length) { body.append(empty('No tasks yet', 'Create a task to save an instruction and choose when it runs.')); return; }
    for (const state of ['active', 'archived']) {
      const group = tasks.filter(t => t.status === state); if (!group.length) continue;
      const rows = el('div', 'entry-list card');
      body.append(el('h3', 'group-name', `${state} · ${group.length}`), rows);
      for (const t of group) rows.append(entry(t.title, t.scheduleText, () => detail(t.id), t.latest?.status || 'Not run'));
    }
  }); }
  function editor(t) { return show((body, notice) => {
    const form = el('form', 'work-card card'), title = el('input'), prompt = el('textarea'), at = el('input'), cron = el('input'), zone = el('input'), label = el('input');
    const type = select([['manual', 'On demand'], ['once', 'One time'], ['cron', 'Recurring']], t?.schedule?.type || 'manual');
    title.required = prompt.required = true; title.maxLength = 160; prompt.maxLength = 12000; prompt.rows = 4;
    title.value = t?.title || ''; prompt.value = t?.prompt || ''; title.placeholder = 'e.g. Morning energy check';
    at.type = 'datetime-local'; at.step = 'any';
    if (t?.schedule?.type === 'once') {
      const date = new Date(t.schedule.at); at.value = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, -1);
    }
    cron.value = t?.schedule?.expression || ''; cron.placeholder = '0 8 * * 1-5'; cron.maxLength = 120;
    zone.value = t?.schedule?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; zone.maxLength = 100;
    label.value = t?.scheduleText || ''; label.maxLength = 120; label.placeholder = 'e.g. Weekdays at 8 AM';
    const once = field('Run at (local time)', at), repeating = el('div', 'field-grid');
    repeating.append(field('Cron expression', cron, 'Minute, hour, day, month, weekday.'), field('Time zone', zone, 'An IANA zone, such as Europe/Berlin.'));
    function scheduleFields() {
      once.hidden = type.value !== 'once'; repeating.hidden = type.value !== 'cron';
      at.required = !once.hidden; cron.required = zone.required = !repeating.hidden;
    }
    type.onchange = () => { scheduleFields(); label.value = ''; }; scheduleFields();
    let requestId = commandId(); form.oninput = () => { requestId = commandId(); };
    form.append(el('h2', '', t ? 'Edit task' : 'New task'), field('Task name', title), field('Instructions', prompt), field('Schedule', type), once, repeating,
      field('Schedule label (optional)', label), actions(el('button', 'primary', t ? 'Save changes' : 'Create task'), button('Cancel', () => t ? detail(t.id) : list())));
    body.append(form); title.focus();
    form.onsubmit = e => { e.preventDefault(); run(notice, async () => {
      const schedule = type.value === 'once' ? { type: 'once', at: new Date(at.value).toISOString() }
        : type.value === 'cron' ? { type: 'cron', expression: cron.value.trim(), timezone: zone.value.trim() } : null;
      const scheduleText = label.value.trim() || (!schedule ? 'On demand' : schedule.type === 'once' ? when(Date.parse(schedule.at)) : `${schedule.expression} · ${schedule.timezone}`).slice(0, 120);
      const task = { title: title.value.trim(), prompt: prompt.value.trim(), schedule, scheduleText };
      const receipt = await post('tasks', { requestId, action: t ? 'update' : 'create', ...(t && { id: t.id, revision:t.revision }), task }).catch(error => {
        if (t && error.status === 409) throw new Error(`${error.message} Your draft is still here. Copy your changes before selecting Cancel to open the saved task.`);
        throw error;
      });
      await detail(receipt.id);
    }); };
  }); }
  function detail(id) { return show(async (body, notice) => {
    const path = `tasks/${encodeURIComponent(id)}`; body.append(button('← All tasks', list, 'back-link'));
    const { task, executions, nextBefore } = await api(path);
    const card = el('div', 'work-card card'), running = task.latest?.status === 'running';
    function command(label, action, extra, style) {
      const requestId = commandId();
      return button(label, () => run(notice, async () => {
        if (action === 'delete' && !await confirmAction('Delete task?', `Remove “${task.title}” and its execution history?`, 'Delete task')) return;
        await post('tasks', { id, requestId, action, ...extra }); await (action === 'delete' ? list() : detail(id));
      }), style);
    }
    const controls = actions();
    if (running) controls.append(command('Stop run', 'stop'));
    else if (task.status === 'active') controls.append(command('Run now', 'run', {}, 'primary'));
    controls.append(button('Edit', () => editor(task)), task.status === 'active' ? command('Archive', 'status', {status:'archived'}) : command('Restore', 'status', {status:'active'}), command('Delete', 'delete', {}, 'secondary danger'));
    card.append(el('p', 'kicker', task.status), el('h2', 'work-title', task.title), el('p', 'read-text', task.prompt), el('p', 'muted', `${task.scheduleText}${task.nextDueAt ? ` · Next run: ${when(task.nextDueAt)}` : ''}`), controls);
    const rows = el('div', 'entry-list card'); let cursor = nextBefore;
    const append = batch => { for (const ex of batch) rows.append(entry(when(ex.startedAt), ex.error || ex.preview, () => result(id, ex.id), ex.status)); };
    append(executions); body.append(card, heading('Execution history', button('Refresh', () => detail(id))), rows);
    if (!executions.length) body.append(empty('Not run yet', 'Execution results will appear here.'));
    const older = button('Older executions', () => run(notice, async () => {
      const page = await api(`${path}?before=${encodeURIComponent(cursor)}`); append(page.executions); cursor = page.nextBefore; older.hidden = !cursor;
    })); older.hidden = !cursor; body.append(older);
  }); }
  function result(id, executionId) { return show(async body => {
    body.append(button('← Task details', () => detail(id), 'back-link'));
    const { execution, answer } = await api(`tasks/${encodeURIComponent(id)}/executions/${encodeURIComponent(executionId)}`);
    const card = el('article', 'work-card card'); card.append(el('p', 'kicker', `Execution · ${execution.status}`), el('h2', 'work-title', when(execution.startedAt)));
    if (execution.error) card.append(el('p', 'error', execution.error));
    card.append(answer ? markdown(answer) : el('p', 'muted', 'No answer recorded yet.')); body.append(card);
  }); }
  return list();
}
