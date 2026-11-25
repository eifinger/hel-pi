import { el } from './ui.js';

// This is a display lexer, not a JS interpreter. Every lexeme, including
// markup inside strings and comments, becomes a text node.
const tokens = /(?<comment>\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|(?<string>"(?:\\[\s\S]|[^"\\\n])*"?|'(?:\\[\s\S]|[^'\\\n])*'?|`(?:\\[\s\S]|[^`\\])*`?)|(?<keyword>\b(?:async|await|break|case|catch|class|const|continue|default|else|export|false|for|from|function|if|import|in|instanceof|let|new|null|of|return|switch|throw|true|try|typeof|undefined|var|while|yield)\b)|(?<number>\b\d+(?:\.\d+)?\b)|\b(?<call>[$\w]+)(?=\s*\()/g;

function highlight(source) {
  const lines = [el('code')];
  function add(text, kind) {
    const parts = text.split('\n');
    parts.forEach((part, index) => {
      if (index) lines.push(el('code'));
      if (part) lines.at(-1).append(kind ? el('span', `tok-${kind}`, part) : part);
    });
  }
  let at = 0;
  for (const match of source.matchAll(tokens)) {
    add(source.slice(at, match.index));
    add(match[0], Object.keys(match.groups).find(key => match.groups[key] !== undefined));
    at = match.index + match[0].length;
  }
  add(source.slice(at)); return lines;
}

// Find matching lines by longest common subsequence, skipping the shared
// prefix/suffix. For very large replacements keep the diff exact without a
// quadratic allocation: the unmatched block is shown as deletes then adds.
export function diffLines(oldLines, newLines) {
  const diff = []; let a = 0, b = 0, endA = oldLines.length, endB = newLines.length;
  function same() { diff.push([a++, b++]); }
  while (a < endA && b < endB && oldLines[a] === newLines[b]) same();
  while (endA > a && endB > b && oldLines[endA - 1] === newLines[endB - 1]) { endA--; endB--; }
  const startA = a, startB = b, width = endB - b + 1;
  if (a < endA && b < endB && (endA - a + 1) * width <= 1_000_000) {
    const lengths = new Uint32Array((endA - a + 1) * width);
    const idx = (i, j) => (i - startA) * width + j - startB;
    for (let i = endA - 1; i >= a; i--) for (let j = endB - 1; j >= b; j--) {
      lengths[idx(i, j)] = oldLines[i] === newLines[j] ? 1 + lengths[idx(i + 1, j + 1)]
        : Math.max(lengths[idx(i + 1, j)], lengths[idx(i, j + 1)]);
    }
    while (a < endA && b < endB) {
      if (oldLines[a] === newLines[b]) same();
      else if (lengths[idx(a + 1, b)] >= lengths[idx(a, b + 1)]) diff.push([a++, null]);
      else diff.push([null, b++]);
    }
  }
  while (a < endA) diff.push([a++, null]);
  while (b < endB) diff.push([null, b++]);
  while (a < oldLines.length) same();
  return diff;
}

export function sourceView(source, previous) {
  const compare = previous !== undefined, current = highlight(source), old = compare ? highlight(previous) : [];
  const rows = compare ? diffLines(previous.split('\n'), source.split('\n')) : current.map((_, i) => [null, i]);
  const pane = el('div', 'code-pane'); pane.tabIndex = 0;
  pane.setAttribute('role', 'region'); pane.setAttribute('aria-label', compare ? 'Source changes' : 'JavaScript source');
  const body = el('div', 'code-lines'); pane.append(body);
  for (const [a, b] of rows) {
    const kind = !compare ? '' : a === null ? ' added' : b === null ? ' removed' : '';
    const row = el('div', `code-line${kind}`);
    if (compare) row.append(el('span', 'gutter', a === null ? '' : a + 1));
    row.append(el('span', 'gutter', b === null ? '' : b + 1));
    if (compare) row.append(el('span', 'change-mark', kind === ' added' ? '+' : kind === ' removed' ? '−' : ' '));
    row.append(b === null ? old[a] : current[b]); body.append(row);
  }
  return pane;
}
