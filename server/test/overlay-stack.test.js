import test from 'node:test';
import assert from 'node:assert/strict';
import { pushOverlay, handleEscape, isEscapeClose, overlayCount } from '../../web/overlay-stack.js';

const key = (o = {}) => ({ key: 'Escape', prevented: 0, stopped: 0, preventDefault() { this.prevented++; }, stopPropagation() { this.stopped++; }, ...o });

test('no overlay open: Esc is left alone (not prevented)', () => {
  const e = key();
  assert.equal(handleEscape(e), false);
  assert.equal(e.prevented, 0);
});
test('closes the top-most overlay first, consumes the key, then the next', () => {
  const closed = [];
  const popA = pushOverlay({ close: () => { closed.push('a'); popA(); } });
  const popB = pushOverlay({ close: () => { closed.push('b'); popB(); } });
  const e1 = key();
  assert.equal(handleEscape(e1), true);
  assert.deepEqual([closed.join(), e1.prevented, e1.stopped], ['b', 1, 1]);
  assert.equal(handleEscape(key()), true);
  assert.deepEqual(closed, ['b', 'a']);
  assert.equal(overlayCount(), 0);
});
test('IME composition Esc and already-handled keys are not hijacked', () => {
  const pop = pushOverlay({ close: () => assert.fail('must not close') });
  for (const o of [{ isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }, { key: 'a' }]) {
    const e = key(o);
    assert.equal(handleEscape(e), false);
    assert.equal(e.prevented, 0);
  }
  pop();
  assert.equal(isEscapeClose(key(), null), false);
});
