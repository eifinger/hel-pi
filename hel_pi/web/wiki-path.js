// Directory entries, editor paths and URLSearchParams values are already literal filenames.
export const validPart = part => !!part && !part.startsWith('.') && !/[/\\\x00-\x1f\x7f]/.test(part) &&
  !/^(?:AGENTS\.md|node_modules|config|state|credentials|secrets|build|dist)$/i.test(part);
export const wikiFile = path => typeof path === 'string' && path.startsWith('wiki/') && /\.md$/i.test(path) && path.slice(5).split('/').every(validPart);

// Only Markdown destinations use URL syntax. Decode each component once; escaped slashes,
// dots, or backslashes cannot become navigation. Raw schemes, queries and fragments aren't files.
export function resolveLink(from, target) {
  if (target.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(target) || /[\\?#]/.test(target)) return;
  const parts = target.startsWith('wiki/') ? [] : from.split('/').slice(0, -1);
  for (const segment of target.split('/')) {
    if (segment === '.') continue;
    if (segment === '..') { if (parts.length <= 1) return; parts.pop(); continue; }
    let name; try { name = decodeURIComponent(segment); } catch { return; }
    if (!validPart(name)) return;
    parts.push(name);
  }
  const path = parts.join('/'); return wikiFile(path) ? path : undefined;
}
