import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shortcutRows } from '../../../../src/ui/shortcuts-panel.js';

const status = (enabled, ...registered) => ({
  enabled,
  shortcuts: [
    { command: 'toggle', label: 'Ctrl+Shift+S', registered: registered[0] },
    { command: 'captions', label: 'Ctrl+Shift+C', registered: registered[1] },
  ],
});

test('the settings list each shortcut with what it does and its keys, in the order given', () => {
  assert.deepEqual(shortcutRows(status(true, true, true)), [
    { nameKey: 'settings.shortcuts.toggle', keys: 'Ctrl+Shift+S', unavailable: false },
    { nameKey: 'settings.shortcuts.captions', keys: 'Ctrl+Shift+C', unavailable: false },
  ]);
});

test('a shortcut another app holds is marked unavailable while shortcuts are on', () => {
  assert.deepEqual(
    shortcutRows(status(true, true, false)).map((row) => row.unavailable),
    [false, true],
  );
});

test('with shortcuts off none is marked unavailable', () => {
  assert.deepEqual(
    shortcutRows(status(false, false, false)).map((row) => row.unavailable),
    [false, false],
  );
});
