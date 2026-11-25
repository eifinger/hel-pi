import { expect, test } from 'bun:test';
import { parseHTML } from 'linkedom';
import { markdown } from '../../web/markdown.js';

test('chat previews finished drawings as images, preserves their source, and never embeds external pictures', () => {
  const previous = globalThis.document;
  globalThis.document = parseHTML('<html></html>').document;
  try {
    const svg = '<svg viewBox="0 0 8 8"><title>House</title><circle r="4"/></svg>';
    const fence = '```svg\n' + svg, chat = text => markdown(text, {chat:true});
    const response = chat(['First:', fence, '```', '![Reference](https://example.org/reference.png)', 'See https://example.org/notes.'].join('\n'));
    expect(response.querySelectorAll('img')).toHaveLength(1);
    expect(response.querySelector('img').getAttribute('src')).toStartWith('data:image/svg+xml');
    expect(response.querySelector('svg')).toBeNull();
    expect(response.querySelector('details code').textContent).toBe(svg);
    expect([...response.querySelectorAll('a')].map(a => a.href)).toEqual(['https://example.org/reference.png','https://example.org/notes']);
    expect(chat(svg).querySelector('img').alt).toBe('House');
    for (const node of [chat(fence), chat('```js\n'+svg+'\n```'), markdown(fence+'\n```')]) {
      expect(node.querySelector('img')).toBeNull(); expect(node.querySelector('code').textContent).toBe(svg);
    }
  } finally { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; }
});
