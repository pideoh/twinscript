// The choices of what is listened to, in the bottom bar: a button that says them
// (`els.listenChoices`, its text in `els.listenSummary`, worded by src/ui/listen-summary.js) and the
// popover it opens (`els.listenPopover`), which holds the language selects, the swap button and the
// audio input select. The selects keep their own handlers (src/ui/settings-dialog.js); this part
// opens and closes the popover and keeps the button's text in step with them.
//
// Escape, or a click outside, closes the popover, and focus goes back to the button when it was in
// it. The button is disabled whenever the language selects are (while listening): the choices cannot
// change then, and the popover closes. Made after the settings dialog, so that its listeners run
// after the selects' own handlers.

import { listenSummary } from './listen-summary.js';

// els: the page's elements; t: i18n; settings: the live settings (langA, langB, langC);
// langLabel(code): a language's name in the display language. render() writes the button's text
// again: call it when the selects were set from code (a session opened) or the display language
// changed.
export function createListenChoices({ els, t, settings, langLabel }) {
  const button = els.listenChoices;
  const popover = els.listenPopover;

  function render() {
    const languages = [settings.langA, settings.langB, settings.langC].filter(Boolean).map(langLabel);
    els.listenSummary.textContent = listenSummary({ languages, input: els.source.selectedOptions[0]?.text ?? '' }, t);
  }

  function open() {
    popover.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    popover.querySelector('select:not(:disabled)')?.focus();
  }
  function close() {
    if (popover.hidden) return;
    const hadFocus = popover.contains(document.activeElement);
    popover.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (hadFocus) button.focus();
  }

  button.onclick = () => (popover.hidden ? open() : close());
  popover.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    close();
  });
  document.addEventListener('pointerdown', (e) => {
    if (!popover.contains(e.target) && !button.contains(e.target)) close();
  });
  for (const el of [els.langA, els.langB, els.langC, els.source]) el.addEventListener('change', render);
  els.swap.addEventListener('click', render);
  // Mirrors the selects: disabled while listening.
  const follow = () => {
    button.disabled = els.langA.disabled;
    if (button.disabled) close();
  };
  new MutationObserver(follow).observe(els.langA, { attributes: true, attributeFilter: ['disabled'] });
  follow();
  render();

  return { render, close };
}
