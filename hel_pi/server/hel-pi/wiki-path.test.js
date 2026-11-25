import { expect, test } from 'bun:test';
import { wikiFile, resolveLink } from '../../web/wiki-path.js';

test('literal wiki filenames round-trip through encoded internal links and the reader query', () => {
  const from = 'wiki/topics/index.md';
  for (const name of ['50%.md', 'Folder: A/FAQs?.md', '#1.md', 'literal%2F.md', 'notes%20for%20later.md']) {
    const path = `wiki/topics/${name}`;
    expect(wikiFile(path)).toBe(true);
    expect(resolveLink(from, name.split('/').map(encodeURIComponent).join('/'))).toBe(path);
    expect(new URLSearchParams('wiki='+encodeURIComponent(path)).get('wiki')).toBe(path);
  }
  expect(resolveLink(from, '../index.md')).toBe('wiki/index.md');
  expect(resolveLink(from, './child.md')).toBe('wiki/topics/child.md');
  expect(resolveLink(from, './Zone:herbs.md')).toBe('wiki/topics/Zone:herbs.md');
  expect(resolveLink(from, 'wiki/reference.md')).toBe('wiki/reference.md');
});

test('unsafe paths are not reader destinations and URL syntax is not treated as a literal Markdown filename', () => {
  for (const path of ['wiki/../private.md','wiki/.hidden/file.md','wiki//index.md','wiki/\\index.md','/wiki/index.md','wiki/page.html','wiki/config/a.md','wiki/x\0.md']) expect(wikiFile(path)).toBe(false);
  for (const target of ['../../other.md', '%2e%2e/x.md', 'part%2fsub.md', 'folder%5Cfile.md', 'page.md?query','page.md#frag','https://test.invalid/x.md','javascript:abc.md','//host/a.md','/root.md','%00.md','bad%.md','folder/AGENTS.md'])
    expect(resolveLink('wiki/topics/index.md',target)).toBeUndefined();
});
