// The sidebar: the list of saved sessions (open, rename, delete), the "new session" button and the
// drawer that holds the list on narrow screens; with the list, the name of the session on screen in
// the header (`els.sessionName`, the same title, or the one it will get while it has none yet). No session can be switched to, and the one being
// recorded cannot be deleted, while a run is in progress.
//
// The list itself is the app's (getSessions()); a deleted session is taken out of it through
// removeSession, since the app replaces the array rather than changing it.

import { formatDateTime, formatElapsed } from '../session/exporter.js';
import { autoTitle, isEmpty } from '../session/session-save.js';

// els: the page's elements; t: i18n; octicon(name): an icon; store: the session store
// (deleteSession); toast(message, ms, variant); getSessions(): the saved sessions, newest first;
// removeSession(sess): takes one out of that list; forgetSave(sess): drops a pending save of it;
// getCurrent(), getRun(): the session on screen and the run in progress (or null);
// showSession(sess): shows a session; blankSession(): a new, empty session; markDirty(sess): saves
// it soon.
export function createSidebar({
  els,
  t,
  octicon,
  store,
  toast,
  getSessions,
  removeSession,
  forgetSave,
  getCurrent,
  getRun,
  showSession,
  blankSession,
  markDirty,
}) {
  function renderSidebar() {
    const current = getCurrent();
    const title = current ? current.title || autoTitle(current) : '';
    els.sessionName.textContent = title;
    els.sessionName.title = title;
    els.sessionList.replaceChildren(
      ...getSessions().map((sess) => {
        const row = document.createElement('div');
        row.className = `session${sess === current ? ' current' : ''}`;
        const open = document.createElement('button');
        open.className = 'open';
        if (sess === current) open.setAttribute('aria-current', 'true');
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = sess.title;
        const when = document.createElement('span');
        when.className = 'when';
        when.textContent = t('session.when', {
          date: formatDateTime(sess.createdAt),
          duration: formatElapsed(sess.activeMs),
        });
        open.append(name, when);
        open.onclick = () => {
          if (canSwitch()) showSession(sess);
        };
        const action = (icon, title, fn) => {
          const b = document.createElement('button');
          b.className = 'act icon-btn';
          b.append(octicon(icon));
          b.title = title;
          b.setAttribute('aria-label', title);
          b.onclick = fn;
          return b;
        };
        row.append(
          open,
          action('pencil', t('session.rename'), () => renameSession(sess)),
          action('trash', t('session.delete'), () => deleteSession(sess)),
        );
        return row;
      }),
    );
  }

  function canSwitch() {
    const run = getRun();
    if (run) toast(t('toast.stopToSwitch'), 6000, 'warning');
    return !run;
  }

  function renameSession(sess) {
    const title = prompt(t('session.renamePrompt'), sess.title)?.trim();
    if (!title) return;
    sess.title = title;
    sess.customTitle = true;
    markDirty(sess);
  }

  async function deleteSession(sess) {
    if (getRun()?.session === sess) return toast(t('toast.stopToDelete'), 6000, 'warning');
    if (!confirm(t('session.deleteConfirm', { title: sess.title }))) return;
    forgetSave(sess);
    removeSession(sess);
    // The session on screen gives way to a blank one at once, so that a start while the store is
    // deleting records into that one, not into the removed session.
    const blank = sess === getCurrent() ? blankSession() : null;
    if (blank) showSession(blank);
    await store
      .deleteSession(sess.id)
      .catch((err) => toast(t('toast.deleteFailed', { message: err.message }), 6000, 'critical'));
    const next = getSessions()[0];
    // Then the newest saved session is shown, unless the blank one was used or left meanwhile.
    if (blank && blank === getCurrent() && !getRun() && isEmpty(blank) && next) showSession(next);
    else renderSidebar();
  }

  els.newSession.onclick = () => {
    if (canSwitch()) showSession(blankSession());
  };
  els.menu.onclick = () => document.body.classList.toggle('drawer');
  els.backdrop.onclick = () => document.body.classList.remove('drawer');

  return { render: renderSidebar };
}
