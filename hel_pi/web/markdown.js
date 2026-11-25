import { el } from './ui.js';

// A deliberately small reader: Markdown creates DOM nodes, never HTML. Images,
// embedded widgets, scripts and unknown link schemes cannot load resources.
export function markdown(text, internalLink) {
  const article = el('div', 'markdown');
  function inline(parent, source) {
    let offset = 0;
    const spans = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
    for (const match of source.matchAll(spans)) {
      parent.append(source.slice(offset, match.index));
      const [, code, strong, emphasis, label, target] = match;
      if (code || strong || emphasis) parent.append(el(code ? 'code' : strong ? 'strong' : 'em', '', code || strong || emphasis));
      else {
        let link = internalLink?.(label, target);
        if (!link && /^https?:\/\//i.test(target) && URL.canParse(target)) {
          const url = new URL(target);
          if (!url.username && !url.password) {
            link = el('a', '', label); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
          }
        }
        parent.append(link || label);
      }
      offset = match.index + match[0].length;
    }
    parent.append(source.slice(offset));
  }
  let para, list, block;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      if (block) block = null;
      else { block = el('code'); const pre = el('pre'); pre.append(block); article.append(pre); }
      para = list = null; continue;
    }
    if (block) { block.append(line + '\n'); continue; }
    if (!line.trim()) { para = list = null; continue; }
    const h = /^(#{1,6})\s+(.+)$/.exec(line), li = /^\s*([-*+]|\d+\.)\s+(.+)$/.exec(line);
    if (h) {
      const node = el('h' + Math.min(6, h[1].length + 1)); inline(node, h[2]); article.append(node); para = list = null;
    } else if (li) {
      const tag = /\d/.test(li[1]) ? 'ol' : 'ul';
      if (list?.localName !== tag) { list = el(tag); article.append(list); }
      const item = el('li'); inline(item, li[2]); list.append(item); para = null;
    } else if (/^>\s?/.test(line)) {
      const quote = el('blockquote'); inline(quote, line.replace(/^>\s?/, '')); article.append(quote); para = list = null;
    } else {
      if (!para) { para = el('p'); article.append(para); } else para.append(' ');
      inline(para, line); list = null;
    }
  }
  return article;
}
