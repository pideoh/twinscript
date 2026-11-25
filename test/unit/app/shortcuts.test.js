import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createShortcuts, SHORTCUTS, shortcutLabel } from '../../../app/shortcuts.js';

function fakeKeys(taken = []) {
  const held = new Map();
  return {
    held,
    register: (accelerator, fn) => {
      if (taken.includes(accelerator) || held.has(accelerator)) return false;
      held.set(accelerator, fn);
      return true;
    },
    unregister: (accelerator) => held.delete(accelerator),
  };
}

test('start / stop and the caption window have their own default shortcuts', () => {
  assert.deepEqual(
    SHORTCUTS.map((s) => [s.command, s.accelerator]),
    [
      ['toggle', 'CommandOrControl+Shift+T'],
      ['captions', 'CommandOrControl+Shift+C'],
    ],
  );
});

test('shortcuts are shown with the modifier names of the platform', () => {
  assert.equal(shortcutLabel('CommandOrControl+Shift+T', 'darwin'), '⇧⌘T');
  assert.equal(shortcutLabel('CommandOrControl+Shift+C', 'win32'), 'Ctrl+Shift+C');
  assert.equal(shortcutLabel('CommandOrControl+Alt+X', 'linux'), 'Ctrl+Alt+X');
  assert.equal(shortcutLabel('Control+Alt+Shift+Command+K', 'darwin'), '⌃⌥⇧⌘K');
});

test('pressing a registered shortcut sends its command', () => {
  const keys = fakeKeys();
  const sent = [];
  const shortcuts = createShortcuts({ ...keys, platform: 'darwin', onCommand: (c) => sent.push(c) });
  const status = shortcuts.setEnabled(true);
  assert.equal(status.enabled, true);
  assert.deepEqual(
    status.shortcuts.map((s) => [s.command, s.label, s.registered]),
    [
      ['toggle', '⇧⌘T', true],
      ['captions', '⇧⌘C', true],
    ],
  );
  keys.held.get('CommandOrControl+Shift+C')();
  keys.held.get('CommandOrControl+Shift+T')();
  assert.deepEqual(sent, ['captions', 'toggle']);
});

test('a shortcut taken by another app is reported, not fatal', () => {
  const keys = fakeKeys(['CommandOrControl+Shift+T']);
  const shortcuts = createShortcuts({ ...keys, platform: 'win32', onCommand: () => {} });
  const status = shortcuts.setEnabled(true);
  assert.deepEqual(
    status.shortcuts.map((s) => [s.command, s.label, s.registered]),
    [
      ['toggle', 'Ctrl+Shift+T', false],
      ['captions', 'Ctrl+Shift+C', true],
    ],
  );
  const throwing = createShortcuts({
    register: () => {
      throw new Error('invalid');
    },
    unregister: () => {},
    platform: 'win32',
    onCommand: () => {},
  });
  assert.deepEqual(
    throwing.setEnabled(true).shortcuts.map((s) => s.registered),
    [false, false],
  );
});

test('turning shortcuts off releases them, and turning them on again retries', () => {
  const taken = ['CommandOrControl+Shift+T'];
  const keys = fakeKeys(taken);
  const shortcuts = createShortcuts({ ...keys, platform: 'darwin', onCommand: () => {} });
  shortcuts.setEnabled(true);
  const off = shortcuts.setEnabled(false);
  assert.equal(off.enabled, false);
  assert.deepEqual(
    off.shortcuts.map((s) => s.registered),
    [false, false],
  );
  assert.equal(keys.held.size, 0, 'nothing stays registered');
  taken.length = 0; // the other app let go of it
  assert.deepEqual(
    shortcuts.setEnabled(true).shortcuts.map((s) => s.registered),
    [true, true],
  );
  assert.deepEqual(shortcuts.status(), shortcuts.setEnabled(true), 'enabling twice changes nothing');
  shortcuts.dispose();
  assert.equal(keys.held.size, 0);
});
