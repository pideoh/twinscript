// The sidebar: the list of saved sessions (open, rename, delete), the "new session" button and the
// drawer that holds the list on narrow screens; with the list, the name of the session on screen in
// the header (`els.sessionName`, the same title, or the one it will get while it has none yet). No session can be switched to, and the one being
// recorded cannot be deleted, while a run is in progress.
//
// The list itself is the app's (getSessions()); a deleted session is taken out of it through
// removeSession, since the app replaces the array rather than changing it.
//
// A session is renamed in its row, in a field in place of its name. The list is made anew whenever
// the app asks (after each round of saves, for one), except the row being edited, which is kept as
// it is. A button of a row that had the focus has it again in the new row of the same session.

import { formatDateTime, formatElapsed } from '../session/exporter.js';
import { autoTitle, isEmpty, typedTitle } from '../session/session-save.js';

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
  // The row whose name is being edited: { sess, row, editor, input }, or null.
  let editing = null;
  // The session each row stands for.
  const sessionOf = new WeakMap();

  function renderHeader() {
    const current = getCurrent();
    const title = current ? current.title || autoTitle(current) : '';
    els.sessionName.textContent = title;
    els.sessionName.title = title;
  }

  function renderSidebar() {
    const focus = focusedButton();
    drawList();
    // The button that had the focus was taken out with its row: the same button of the session's new
    // row takes it, if the session is still listed.
    if (focus && !focus.button.isConnected) {
      const row = [...els.sessionList.children].find((r) => sessionOf.get(r) === focus.sess);
      row?.querySelectorAll('button')[focus.at]?.focus();
    }
  }

  // Which button of which session's row has the focus, or null.
  function focusedButton() {
    const button = document.activeElement;
    const row = button?.tagName === 'BUTTON' ? button.closest('.session') : null;
    if (!row || row.parentElement !== els.sessionList) return null;
    return { button, sess: sessionOf.get(row), at: [...row.querySelectorAll('button')].indexOf(button) };
  }

  function drawList() {
    renderHeader();
    const current = getCurrent();
    const sessions = getSessions();
    if (editing && !sessions.includes(editing.sess)) editing = null;
    const rows = sessions.map((sess) => (sess === editing?.sess ? editing.row : sessionRow(sess, current)));
    if (!editing) {
      els.sessionList.replaceChildren(...rows);
      return;
    }
    // The row being edited stays in the page, so that what is typed, the focus and the selection
    // are kept; the rows around it are made anew.
    const { row } = editing;
    row.classList.toggle('current', editing.sess === current);
    for (const other of [...els.sessionList.children]) if (other !== row) other.remove();
    const at = rows.indexOf(row);
    row.before(...rows.slice(0, at));
    row.after(...rows.slice(at + 1));
  }

  function sessionRow(sess, current) {
    const row = document.createElement('div');
    row.className = `session${sess === current ? ' current' : ''}`;
    sessionOf.set(row, sess);
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
      openButton(sess, current),
      action('pencil', t('session.rename'), () => editName(sess, row)),
      action('trash', t('session.delete'), () => deleteSession(sess)),
    );
    return row;
  }

  function openButton(sess, current) {
    const open = document.createElement('button');
    open.className = 'open';
    if (sess === current) open.setAttribute('aria-current', 'true');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = sess.title;
    open.append(name, when(sess));
    open.onclick = () => {
      if (canSwitch()) showSession(sess);
    };
    return open;
  }

  function when(sess) {
    const span = document.createElement('span');
    span.className = 'when';
    span.textContent = t('session.when', {
      date: formatDateTime(sess.createdAt),
      duration: formatElapsed(sess.activeMs),
    });
    return span;
  }

  // The session's name becomes a field in its row (no system dialog: the desktop app has none).
  // Enter or leaving the field keeps what was typed, Escape leaves the name as it was; Enter and
  // Escape put the focus back on the row's pencil. One row at a time.
  function editName(sess, row) {
    if (editing) finishEditing(true);
    const editor = document.createElement('div');
    editor.className = 'renaming';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'text-input';
    input.autocomplete = 'off';
    input.value = sess.title;
    input.setAttribute('aria-label', t('session.renamePrompt'));
    input.addEventListener('keydown', (e) => {
      // An Enter or Escape that ends the composition of an input method is the input method's.
      if (e.isComposing || (e.key !== 'Enter' && e.key !== 'Escape')) return;
      e.preventDefault();
      finishEditing(e.key === 'Enter', true);
    });
    input.addEventListener('blur', () => {
      if (editing?.input === input) finishEditing(true);
    });
    editor.append(input, when(sess));
    row.querySelector('.open').replaceWith(editor);
    editing = { sess, row, editor, input };
    input.focus();
    input.select();
  }

  // keep: whether what was typed becomes the name; refocus: whether the focus goes back to the
  // row's pencil (not when it has already gone elsewhere). Only this row changes, so that a click
  // that took the focus away still lands on what was clicked.
  function finishEditing(keep, refocus = false) {
    const { sess, row, editor, input } = editing;
    editing = null;
    const title = keep ? typedTitle(input.value, sess.title) : null;
    if (title) {
      sess.title = title;
      sess.customTitle = true;
      markDirty(sess);
    }
    editor.replaceWith(openButton(sess, getCurrent()));
    renderHeader();
    if (refocus) row.querySelector('.act').focus();
  }

  function canSwitch() {
    const run = getRun();
    if (run) toast(t('toast.stopToSwitch'), 6000, 'warning');
    return !run;
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
