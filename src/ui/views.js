// The tabs of the main area (Transcript, Summary, ...), in the ARIA tabs pattern: one tab stop
// (roving tabindex), Left / Right / Home / End move between the tabs and select, the panel is the
// next stop. The tabs and their panels are read from the page: a tab is `[role="tab"][data-view]`
// inside the tab list (`els.tabs`), its panel the `[role="tabpanel"]` with the same `data-view`. A
// further tab is its markup (a tab in the list, in the order shown, and a panel) plus, if its panel
// has to be brought up to date when shown, an entry in `onShow`. The first tab is the default. Which
// tab is shown is not stored.

// Which tab is shown after `event`, from the tabs' names in order (`names`) and the one shown now
// (`current`). event: { type: 'opened' } (a session is shown), { type: 'started' } (a run starts),
// { type: 'pressed', name } (a tab is clicked), { type: 'key', key } (a key on a tab). null: the event
// is not one the tabs answer (another key, an unknown tab); nothing changes.
export function viewAfter(names, current, event) {
  if (!names.length) return null;
  const at = Math.max(0, names.indexOf(current));
  switch (event.type) {
    case 'opened':
    case 'started':
      return names[0];
    case 'pressed':
      return names.includes(event.name) ? event.name : null;
    case 'key': {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
      if (step) return names[(at + step + names.length) % names.length];
      if (event.key === 'Home') return names[0];
      if (event.key === 'End') return names[names.length - 1];
      return null;
    }
    default:
      return null;
  }
}

// els: the page's elements (tabs: the tab list); onShow: { [name]: () => … }, what to do when that
// tab is shown (bring its panel up to date).
export function createViews({ els, onShow = {} }) {
  const tabs = [...els.tabs.querySelectorAll('[role="tab"][data-view]')];
  const names = tabs.map((tab) => tab.dataset.view);
  const panelOf = (name) => els.tabs.ownerDocument.querySelector(`[role="tabpanel"][data-view="${name}"]`);
  let shown = names[0];

  function show(name) {
    if (!names.includes(name)) return;
    shown = name;
    for (const tab of tabs) {
      const selected = tab.dataset.view === name;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      const panel = panelOf(tab.dataset.view);
      if (panel) panel.hidden = !selected;
    }
    onShow[name]?.();
  }

  // Shows the tab the rule gives for `event`; returns it, or null when nothing changed.
  function handle(event) {
    const name = viewAfter(names, shown, event);
    if (name) show(name);
    return name;
  }

  for (const tab of tabs) tab.onclick = () => handle({ type: 'pressed', name: tab.dataset.view });
  els.tabs.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const name = handle({ type: 'key', key: e.key });
    if (!name) return;
    e.preventDefault();
    tabs[names.indexOf(name)].focus();
  });
  show(shown);

  return { show, current: () => shown, handle };
}
