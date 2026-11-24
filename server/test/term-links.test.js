import test from 'node:test';
import assert from 'node:assert/strict';
import { safeLinkUrl } from '../../web/term-links.js';

test('safeLinkUrl accepts http and https only', () => {
  assert.equal(safeLinkUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(safeLinkUrl('http://example.com'), 'http://example.com/');
  assert.equal(safeLinkUrl('  https://example.com  '), 'https://example.com/');
  for (const bad of ['', 'about:blank', 'javascript:alert(1)', 'file:///etc/hosts', 'ftp://x.org', 'example.com', '/relative', null, undefined, 42]) {
    assert.equal(safeLinkUrl(bad), null, String(bad));
  }
});
