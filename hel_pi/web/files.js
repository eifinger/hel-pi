import { api, el, button, confirmAction } from './ui.js';
import { screen, actions, heading, entry, empty, when, run } from './workspace.js';
import { markdown } from './markdown.js';

const parent = path => path.split('/').slice(0, -1).join('/');
const bytes = size => size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${Math.ceil(size / 1024)} KiB` : `${(size / 1024 / 1024).toFixed(1)} MiB`;
export function openFiles(view) {
  const artifacts = view === 'artifacts', root = artifacts ? '' : '.agents/skills', show = screen(view);
  const endpoint = path => `${artifacts ? 'artifacts' : 'workspace'}?path=${encodeURIComponent(path)}`;
  function remove(path, folder, notice) { return button(folder ? 'Delete folder' : 'Delete file', () => run(notice, async () => {
    if (!await confirmAction(`Delete ${folder ? 'folder' : 'file'}?`, `Permanently delete “${path}”${folder ? ' and all its contents' : ''}?`, 'Delete')) return;
    await api(endpoint(path), {method:'DELETE'}); await directory(parent(path));
  }), 'secondary danger'); }
  function directory(path = root) { return show(async (body, notice) => {
    if (path !== root) body.append(button('↑ Parent folder', () => directory(parent(path)), 'back-link'));
    const data = await api(endpoint(path));
    body.append(heading(path === root ? artifacts ? 'All artifacts' : 'Available skills' : path.slice(root ? root.length + 1 : 0), ...(artifacts && path ? [remove(path, true, notice)] : [])));
    if (!data.entries.length) { body.append(empty('This folder is empty', artifacts ? 'Files created by Hel-Pi will appear here.' : 'There are no guides in this folder.')); return; }
    const rows = el('div', 'entry-list card'); body.append(rows);
    for (const item of data.entries) {
      const folder = item.kind === 'directory';
      rows.append(entry(item.name, artifacts ? [!folder && bytes(item.size), when(item.modifiedAt)].filter(Boolean).join(' · ') : '',
        () => folder ? directory(item.path) : file(item), folder ? 'Folder' : 'File'));
    }
  }); }
  function file(item) { return show(async (body, notice) => {
    body.append(button('↑ Parent folder', () => directory(parent(item.path)), 'back-link'));
    const card = el('article', 'work-card card'); body.append(card);
    card.append(el('p', 'kicker', artifacts ? 'Artifact' : 'Skill document'), el('h2', 'work-title', item.name), el('code', 'muted', item.path));
    if (artifacts) {
      const link = el('a', 'download-link', 'Download file'); link.download = item.name; link.href = `api/artifacts/download?path=${encodeURIComponent(item.path)}`;
      card.append(actions(link, remove(item.path, false, notice)));
      if (!item.preview || item.size > 1024 * 1024) { card.append(el('p', 'muted', 'No inline preview. Download this file to open it.')); return; }
    }
    const preview = await api(artifacts ? `artifacts/content?path=${encodeURIComponent(item.path)}` : endpoint(item.path));
    const text = artifacts ? preview.content : preview.text;
    card.append((artifacts ? preview.preview === 'markdown' : /\.md$/i.test(item.name)) ? markdown(text) : el('pre', 'read-text file-text', text));
  }); }
  return directory();
}
