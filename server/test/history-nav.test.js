import test from 'node:test';
import assert from 'node:assert/strict';
import { nextPromptTarget } from '../../web/history-nav.js';

// prompts at 0, 500, 1200; content 1500 tall in a 600 tall view => maxScroll 900
const tops = [0, 500, 1200];

test('nextPromptTarget: next prompt below the top edge', () => {
  assert.equal(nextPromptTarget(tops, 0, 900), 500);
  assert.equal(nextPromptTarget(tops, 300, 900), 500);
});

test('nextPromptTarget: current prompt at the top is not the next one', () => {
  assert.equal(nextPromptTarget(tops, 500, 900), 900); // 1200 clamps to the bottom
  assert.equal(nextPromptTarget(tops, 504, 900), 900);
});

test('nextPromptTarget: last prompt visible with the view at the bottom: none', () => {
  assert.equal(nextPromptTarget(tops, 900, 900), null);
  assert.equal(nextPromptTarget(tops, 895, 900), null); // within the slack of the bottom
});

test('nextPromptTarget: last prompt on screen but the view can still scroll: the jump moves', () => {
  assert.equal(nextPromptTarget(tops, 700, 900), 900);
});

test('nextPromptTarget: no prompts, or content shorter than the view', () => {
  assert.equal(nextPromptTarget([], 0, 900), null);
  assert.equal(nextPromptTarget([0, 100], 0, 0), null);
  assert.equal(nextPromptTarget([0, 100], 0, -50), null);
});
