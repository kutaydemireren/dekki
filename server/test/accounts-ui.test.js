import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { accountsButtonLabel, accountRows, addAccountExample, ADD_ACCOUNT_CMD, LOGIN_CMD } from '../../web/accounts-ui.js';
import { demoAccounts } from '../demo.js';
import { paletteActions } from '../../web/palette.js';

test('button label is the active account, with a fallback before the list loads', () => {
  assert.equal(accountsButtonLabel([], 'default'), 'Accounts');
  assert.equal(accountsButtonLabel(undefined, 'x'), 'Accounts');
  assert.equal(accountsButtonLabel([{ id: 'default', label: 'Default' }], 'default'), 'Default');
  assert.equal(accountsButtonLabel([{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], 'b'), 'B');
});

test('rows mark the current account and disable a missing one with a note', () => {
  const rows = accountRows([{ id: 'a', label: 'A' }, { id: 'b', label: 'B', missing: true }], 'a');
  assert.deepEqual(rows.map((r) => [r.current, r.disabled, r.note]), [[true, false, ''], [false, true, '(config dir missing)']]);
  assert.equal(accountRows([{ id: 'a', label: 'A', missing: true }], 'a')[0].disabled, false); // the current one stays clickable (closes)
});

test('the how-to commands match the SPEC steps', () => {
  assert.equal(ADD_ACCOUNT_CMD, 'node scripts/add-account.mjs Second ~/.claude-second');
  assert.equal(LOGIN_CMD, 'CLAUDE_CONFIG_DIR=~/.claude-second claude auth login');
});

test('the add-account example follows the account count', () => {
  assert.equal(addAccountExample(1).addCmd, ADD_ACCOUNT_CMD);
  assert.equal(addAccountExample(1).loginCmd, LOGIN_CMD);
  assert.deepEqual([addAccountExample(2).label, addAccountExample(2).dir], ['Third', '~/.claude-third']);
  assert.equal(addAccountExample(2).addCmd, 'node scripts/add-account.mjs Third ~/.claude-third');
  assert.equal(addAccountExample(2).loginCmd, 'CLAUDE_CONFIG_DIR=~/.claude-third claude auth login');
  assert.equal(addAccountExample(10).addCmd, 'node scripts/add-account.mjs Account11 ~/.claude-11');
  assert.equal(addAccountExample(0).label, 'Second');
  assert.equal(addAccountExample(undefined).label, 'Second');
});

test('the Accounts palette action is found by "acc" and by its keywords', () => {
  const acts = [{ id: 'accounts', label: 'Accounts', keywords: 'account switch add claude login', run() {} }];
  assert.equal(paletteActions(acts, 'acc').length, 1);
  assert.equal(paletteActions(acts, 'login').length, 1);
});

test('demo accounts: single by default, two fictional ones with DEKKI_DEMO_ACCOUNTS=2', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-demo-acct-'));
  try {
    assert.deepEqual(demoAccounts(dir, undefined), { accounts: [] });
    assert.deepEqual(demoAccounts(dir, '1'), { accounts: [] });
    const two = demoAccounts(dir, '2');
    assert.equal(two.accounts.length, 2);
    assert.ok(fs.statSync(two.accounts[1].configDir).isDirectory());
    assert.ok(two.accounts[1].configDir.startsWith(dir));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
