// Global shortcuts of the desktop app: which keys do what, and how registering them turns into
// the status the settings dialog shows. Electron-free; main.js passes in globalShortcut.

// command: what the page is told to do (the same as pressing #toggle or #pip).
export const SHORTCUTS = Object.freeze([
  Object.freeze({ command: 'toggle', accelerator: 'CommandOrControl+Shift+T' }),
  Object.freeze({ command: 'captions', accelerator: 'CommandOrControl+Shift+C' }),
]);

const MAC_KEYS = { CommandOrControl: '⌘', Command: '⌘', Control: '⌃', Ctrl: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧' };
const OTHER_KEYS = { CommandOrControl: 'Ctrl', Control: 'Ctrl', Command: 'Ctrl' };

// The accelerator as people see it on that platform: "⇧⌘T" on macOS (modifiers in Apple's order),
// "Ctrl+Shift+T" elsewhere.
export function shortcutLabel(accelerator, platform) {
  const parts = accelerator.split('+');
  if (platform !== 'darwin') return parts.map((p) => OTHER_KEYS[p] ?? p).join('+');
  const order = ['⌃', '⌥', '⇧', '⌘'];
  const key = parts.pop();
  const mods = parts.map((p) => MAC_KEYS[p] ?? p).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return `${mods.join('')}${key}`;
}

// register(accelerator, callback) -> boolean (false or a throw: taken by another app);
// unregister(accelerator); onCommand(command) when a shortcut is pressed.
// Returns { setEnabled(on) -> status, status() -> status, dispose() }, where status is
// { enabled, shortcuts: [{ command, accelerator, label, registered }] }.
export function createShortcuts({ register, unregister, onCommand, platform }) {
  let enabled = false;
  const registered = new Map(SHORTCUTS.map((s) => [s.command, false]));

  const tryRegister = ({ command, accelerator }) => {
    try {
      return register(accelerator, () => onCommand(command)) === true;
    } catch {
      return false;
    }
  };
  const status = () => ({
    enabled,
    shortcuts: SHORTCUTS.map(({ command, accelerator }) => ({
      command,
      accelerator,
      label: shortcutLabel(accelerator, platform),
      registered: registered.get(command),
    })),
  });
  const release = () => {
    for (const { command, accelerator } of SHORTCUTS) {
      if (registered.get(command)) unregister(accelerator);
      registered.set(command, false);
    }
  };

  return {
    // Turning on again retries the ones that could not be registered before.
    setEnabled(on) {
      enabled = !!on;
      if (!enabled) release();
      else for (const s of SHORTCUTS) if (!registered.get(s.command)) registered.set(s.command, tryRegister(s));
      return status();
    },
    status,
    dispose: release,
  };
}
