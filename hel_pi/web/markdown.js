import { el } from './ui.js';

function externalLink(label, target) {
  if (!/^https?:\/\//i.test(target) || !URL.canParse(target)) return;
  const url = new URL(target);
  if (url.username || url.password) return;
  const link = el('a', '', label); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
  return link;
}

function chatText(parent, text) {
  let start = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    let url = match[0].replace(/[.,;:!?\]]+$/, '');
    if (url.endsWith(')') && url.split(')').length > url.split('(').length) url = url.slice(0, -1);
    const link = externalLink(url, url);
    if (!link) continue;
    parent.append(text.slice(start, match.index), link); start = match.index + url.length;
  }
  parent.append(text.slice(start));
}

// Keep the drawing in the browser's image decoder, never in the app's DOM or an iframe.
function svgPicture(text, pre) {
  const svg = text.trim().replace(/^<\?xml\s[^?]*\?>\s*/, '');
  if (svg.length > 256 * 1024 || !/^<svg(?:\s|>)/.test(svg) || !/<\/svg>$/.test(svg)) return;
  const figure = el('figure', 'chat-visual'), image = el('img');
  const details = el('details'), summary = el('summary', '', 'SVG source');
  image.alt = svg.match(/<title>([^<>]+)<\/title>/)?.[1] || 'Assistant drawing';
  image.onerror = () => { image.remove(); summary.textContent = 'Preview unavailable · SVG source'; details.open = true; };
  const source = svg.replace(/^<svg(?=[\s>])([^>]*)>/, (tag, attrs) => /\sxmlns\s*=/.test(attrs) ? tag : `<svg xmlns="http://www.w3.org/2000/svg"${attrs}>`);
  image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(source.toWellFormed());
  details.append(summary, pre); figure.append(image, details); return figure;
}

// Markdown creates DOM nodes, never HTML. Wiki links resolve separately; only chat previews images.
export function markdown(text, {internalLink, chat = false} = {}) {
  const article = el('div', 'markdown');
  const plain = (parent, text) => chat ? chatText(parent, text) : parent.append(text);
  function inline(parent, source) {
    let offset = 0;
    const spans = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|(!?)\[([^\]\n]*)\]\(([^)\s]+)\)/g;
    for (const match of source.matchAll(spans)) {
      plain(parent, source.slice(offset, match.index));
      const [, code, strong, emphasis, picture, label, target] = match;
      if (code || strong || emphasis) parent.append(el(code ? 'code' : strong ? 'strong' : 'em', '', code || strong || emphasis));
      else if (chat && picture && /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z\d+/]+=*$/i.test(target)) {
        const img = el('img', 'chat-picture'); img.alt = label || 'Embedded image'; img.src = target; parent.append(img);
      } else parent.append(internalLink?.(label, target) || externalLink(label || 'Open image', target) || label);
      offset = match.index + match[0].length;
    }
    plain(parent, source.slice(offset));
  }
  function codeBlock(source, visual) {
    const pre = el('pre'); pre.append(el('code', '', source));
    return visual && svgPicture(source, pre) || pre;
  }
  if (chat && /^\s*(?:<\?xml\s[^?]*\?>\s*)?<svg[\s>]/.test(text)) {
    article.append(codeBlock(text, true)); return article;
  }
  let para, list, fence, language, lines;
  for (const line of text.split(/\r?\n/)) {
    if (fence) {
      const end = line.trim();
      if (end.startsWith(fence) && [...end].every(c => c === fence[0])) {
        article.append(codeBlock(lines.join('\n'), chat && ['', 'svg', 'xml', 'html'].includes(language))); fence = null;
      } else lines.push(line);
      continue;
    }
    const open = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (open) {
      fence = open[1]; language = open[2].trim().toLowerCase(); lines = [];
      para = list = null; continue;
    }
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
  if (fence) article.append(codeBlock(lines.join('\n'), false));
  return article;
}
