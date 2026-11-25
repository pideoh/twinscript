// Global shortcuts in the settings (desktop app). The main process registers them (app/shortcuts.js,
// exposed as window.appShortcuts); each one does what its button does.

// The rows of the shortcut list from the main process's status
// ({ enabled, shortcuts: [{ command, label, registered }] }): what it does (a message key), its keys,
// and whether to say it is unavailable (on, but taken by another app).
export const shortcutRows = (status) =>
  status.shortcuts.map((s) => ({
    nameKey: `settings.shortcuts.${s.command}`,
    keys: s.label,
    unavailable: !!status.enabled && !s.registered,
  }));

// els: the page's elements; t: i18n; settings: the live settings object (globalShortcuts);
// bridge(): window.appShortcuts, or undefined outside the desktop app; onCommand(command): a
// shortcut was pressed ('toggle' or 'captions').
export function createShortcutsPanel({ els, t, settings, bridge, onCommand }) {
  let shortcutStatus = null; // { enabled, shortcuts: [{ command, label, registered }] }
  els.shortcutsGroup.hidden = !bridge();

  function renderShortcuts() {
    if (!shortcutStatus) return;
    els.globalShortcuts.checked = shortcutStatus.enabled;
    els.shortcutList.replaceChildren(
      ...shortcutRows(shortcutStatus).flatMap((s) => {
        const name = document.createElement('dt');
        name.textContent = t(s.nameKey);
        const keys = document.createElement('dd');
        const kbd = document.createElement('kbd');
        kbd.textContent = s.keys;
        keys.append(kbd);
        if (s.unavailable) {
          const note = document.createElement('span');
          note.className = 'shortcut-unavailable';
          note.textContent = t('settings.shortcuts.unavailable');
          keys.prepend(note);
        }
        return [name, keys];
      }),
    );
  }
  async function showShortcuts() {
    if (!bridge()) return;
    try {
      shortcutStatus = await bridge().status();
    } catch {
      return;
    }
    renderShortcuts();
  }
  async function applyGlobalShortcuts() {
    if (!bridge()) return;
    try {
      shortcutStatus = await bridge().setEnabled(settings.globalShortcuts);
    } catch {
      return;
    }
    renderShortcuts();
  }
  bridge()?.onCommand(onCommand);
  if (bridge() && !settings.globalShortcuts) applyGlobalShortcuts();

  return { render: renderShortcuts, show: showShortcuts, apply: applyGlobalShortcuts };
}
