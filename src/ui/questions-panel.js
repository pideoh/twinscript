// The Questions tab of the main area: questions about a finished session and their answers, as a
// conversation, with a field at the bottom to ask the next one. The request is src/session/ask.js;
// questions are stored one by one (store.putQuestion) when their answer is complete and live in the
// session as `questions`, oldest first, once it is opened.
//
// One question at a time per session: while its answer streams in, the field can be edited but not
// sent, and Stop cancels it. An answer that is cancelled or fails is not saved; the question goes
// back to the field (unless something new was typed there) and a failure is said at the turn. An
// answer that arrives after its session was deleted is dropped quietly. While listening, nothing is
// asked. Times an answer cites become buttons that show that line of the transcript, made from the
// rendered text (outside code and links), so the Markdown renderer stays as it is. The rules are the
// pure functions exported first; the factory reads the page and calls them.

import { MockAsker } from '../debug/mock.js';
import { askLines, cleanQuestion, GeminiAsker, segmentAt, splitTimes } from '../session/ask.js';
import { markdownToHtml } from '../session/markdown.js';
import { hasFinished } from '../session/summaries.js';
import { addTokens, emptyUsage } from '../usage/usage.js';
import { langName } from './langs.js';

// What the panel shows for the session on screen. finished: it has a finished line; running: a run
// is in progress; asking: an answer for it is on its way; text: what the field holds.
//   empty: the line saying there is no transcript yet, in place of the conversation
//   note: the message key of the note above the field, or ''
//   fieldDisabled, askDisabled: the field and the Ask button; stopShown: Stop in place of Ask
export function panelState({ finished, running, asking, text }) {
  return {
    empty: !finished && !running,
    note: running ? 'questions.whileListening' : '',
    fieldDisabled: running,
    askDisabled: running || asking || !cleanQuestion(text),
    stopShown: asking,
  };
}

// Whether a key pressed in the field asks the question: Enter, not Shift+Enter (a new line), and
// not the Enter that confirms a word in an input method (Japanese, Chinese).
export const asksOnKey = ({ key, shiftKey, isComposing, keyCode }) =>
  key === 'Enter' && !shiftKey && !isComposing && keyCode !== 229;

// Where a cited time is left as text even when it is in the transcript: inside code and links.
export const TIMES_LEFT_IN = 'a, code, pre';

// A piece of rendered answer text split into text and the times that become controls: a time in
// square brackets (splitTimes) that segmentAt finds in `segments` (the session's, `endMs` its
// length) is { type: 'time', text, index }; everything else, a time not in the transcript included,
// is { type: 'text', text }. Joining the texts gives `text` back.
export function answerPieces(text, segments, endMs) {
  const out = [];
  for (const piece of splitTimes(text)) {
    const index = piece.type === 'time' ? segmentAt(segments, piece.seconds, endMs) : -1;
    if (index >= 0) out.push({ type: 'time', text: piece.text, index });
    else if (out.at(-1)?.type === 'text') out.at(-1).text += piece.text;
    else out.push({ type: 'text', text: piece.text });
  }
  return out;
}

// What the field holds after an answer was cancelled or failed: the question again, unless the
// user has typed something else meanwhile.
export const fieldAfterFailure = (current, question) => (String(current ?? '').trim() ? current : question);

// A question as the confirmation to delete it quotes it: one line, at most `max` characters.
export function quotedQuestion(question, max = 60) {
  const line = String(question ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

// els: the page's elements; t: i18n; octicon(name): an icon; settings: the live settings
// (translateModel); store: the session store (putQuestion, deleteQuestion); toast(message, ms,
// variant); errorText(err): an error's message; uid(): a new id; getCurrent(), getRun(): the session
// on screen and the run in progress (or null); getApiKey(): the API key now; openSettings(): opens
// the settings dialog; markDirty(sess): saves it soon; isDeleted(sess): the user deleted it;
// recordUsage(sess, usage): counts what a request used; speakerName(sess, id): a speaker's name or
// ''; summariesOf(sess): its summaries ([{ markdown }], oldest first); showTab(name): shows a tab of
// the main area; showLine(index): brings the session's segment `index` into view in the transcript
// and marks it; mock: the demo mode.
export function createQuestionsPanel({
  els,
  t,
  octicon,
  settings,
  store,
  toast,
  errorText,
  uid,
  getCurrent,
  getRun,
  getApiKey,
  openSettings,
  markDirty,
  isDeleted,
  recordUsage,
  speakerName,
  summariesOf,
  showTab,
  showLine,
  mock = false,
}) {
  const pending = new WeakMap(); // session -> { question, text, error, controller } of the turn not saved yet
  const drafts = new WeakMap(); // session -> what its field held
  let fieldOf = null; // the session whose draft is in the field
  let live = null; // { sess, answer, status }: the elements of the turn being answered, on screen

  const questionsOf = (sess) => sess.questions ?? [];
  const askingFor = (sess) => !!pending.get(sess)?.controller;

  const nearBottom = () => {
    const log = els.questionsLog;
    return log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  };
  const toBottom = () => {
    els.questionsLog.scrollTop = els.questionsLog.scrollHeight;
  };

  function timeButton(sess, { text, index }) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'time-link';
    button.textContent = text;
    button.setAttribute('aria-label', t('questions.showLine', { time: text }));
    button.onclick = () => {
      if (getCurrent() !== sess) return;
      showTab('transcript');
      showLine(index);
    };
    return button;
  }

  // The answer as Markdown (escaped by markdown.js), then its cited times as controls.
  function fillAnswer(box, markdown, sess) {
    box.innerHTML = markdown ? markdownToHtml(markdown, { headingLevel: 3 }) : '';
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
    for (const node of nodes) {
      if (node.parentElement.closest(TIMES_LEFT_IN)) continue;
      const pieces = answerPieces(node.data, sess.segments, sess.activeMs);
      if (!pieces.some((p) => p.type === 'time')) continue;
      node.replaceWith(...pieces.map((p) => (p.type === 'time' ? timeButton(sess, p) : p.text)));
    }
  }

  const note = (text, className = 'summary-note') => {
    const p = document.createElement('p');
    p.className = className;
    p.textContent = text;
    return p;
  };

  // One turn: the question (with its delete control once saved), then the answer and its notes.
  function turnItem(sess, turn, isPending = false) {
    const li = document.createElement('li');
    li.className = 'turn';
    const head = document.createElement('div');
    head.className = 'turn-question';
    head.append(note(turn.question, 'turn-question-text'));
    if (!isPending) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'icon-btn';
      del.title = t('questions.delete');
      del.setAttribute('aria-label', t('questions.delete'));
      del.append(octicon('trash'));
      del.onclick = () => remove(sess, turn);
      head.append(del);
    }
    const body = document.createElement('div');
    body.className = 'turn-answer';
    const answer = document.createElement('div');
    answer.className = 'markdown';
    fillAnswer(answer, turn.answer, sess);
    body.append(answer);
    if (turn.truncated) body.append(note(t('questions.truncated'), 'summary-note turn-truncated'));
    if (turn.error) body.append(note(turn.error, 'turn-error'));
    const status = note(t('questions.answering'));
    status.hidden = !isPending || !!turn.answer || !!turn.error;
    body.append(status);
    li.append(head, body);
    return { li, answer, status };
  }

  // The field, the buttons and the notes, from panelState.
  function renderControls() {
    const sess = getCurrent();
    if (!sess) return;
    if (fieldOf !== sess) {
      fieldOf = sess;
      els.question.value = drafts.get(sess) ?? '';
    }
    const state = panelState({
      finished: hasFinished(sess),
      running: !!getRun(),
      asking: askingFor(sess),
      text: els.question.value,
    });
    els.questionsEmpty.hidden = !state.empty;
    els.questions.hidden = state.empty;
    els.questionsNote.textContent = state.note ? t(state.note) : '';
    els.questionsNote.hidden = !state.note;
    els.question.disabled = state.fieldDisabled;
    els.ask.disabled = state.askDisabled;
    els.ask.hidden = state.stopShown;
    els.askStop.hidden = !state.stopShown;
    const entry = pending.get(sess);
    els.questionsStatus.textContent = entry?.controller ? t('questions.answering') : (entry?.error ?? '');
  }

  function render() {
    const sess = getCurrent();
    if (!sess) return;
    renderControls();
    const entry = pending.get(sess);
    const turns = questionsOf(sess).map((turn) => turnItem(sess, turn).li);
    live = null;
    if (entry) {
      const shown = turnItem(sess, { question: entry.question, answer: entry.text, error: entry.error }, true);
      live = { sess, answer: shown.answer, status: shown.status };
      turns.push(shown.li);
    }
    els.questionsIntro.hidden = turns.length > 0;
    els.questionsList.replaceChildren(...turns);
  }

  // While the answer streams in, the turn follows it at most once a frame, and the view follows the
  // answer unless the reader has scrolled up.
  let frame = 0;
  function follow(sess) {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const entry = pending.get(sess);
      if (!entry || live?.sess !== sess || getCurrent() !== sess) return;
      const near = nearBottom();
      fillAnswer(live.answer, entry.text, sess);
      live.status.hidden = !!entry.text;
      if (near) toBottom();
    });
  }

  // Back to the field after an answer, when the reader is in this panel (or nowhere in particular).
  function refocus() {
    const at = document.activeElement;
    if (els.questionsPanel.hidden || els.question.disabled) return;
    if (!at || at === document.body || els.questionsPanel.contains(at)) els.question.focus();
  }

  function giveBack(sess, question) {
    if (getCurrent() === sess) els.question.value = fieldAfterFailure(els.question.value, question);
    else drafts.set(sess, fieldAfterFailure(drafts.get(sess), question));
  }

  async function ask() {
    const sess = getCurrent();
    const question = cleanQuestion(els.question.value);
    if (!sess || !question || getRun() || askingFor(sess) || !hasFinished(sess)) return;
    if (!mock && !getApiKey()) {
      toast(t('toast.apiKeyFirst'), 6000, 'warning');
      return openSettings();
    }
    const model = mock ? 'demo' : settings.translateModel;
    const onUsage = (usageMetadata, used) =>
      recordUsage(sess, addTokens(emptyUsage(), 'question', used, usageMetadata));
    const asker = mock
      ? new MockAsker({ model: settings.translateModel, onUsage })
      : new GeminiAsker({ apiKey: getApiKey(), model, onUsage });
    const entry = { question, text: '', error: '', controller: new AbortController() };
    pending.set(sess, entry);
    els.question.value = '';
    drafts.set(sess, '');
    render();
    toBottom();
    try {
      const result = await asker.ask({
        segments: askLines(sess.segments, (id) => speakerName(sess, id)),
        summaries: summariesOf(sess),
        history: questionsOf(sess).map(({ question, answer }) => ({ question, answer })),
        question,
        langs: [sess.langA, sess.langB, sess.langC].map(langName).filter(Boolean),
        signal: entry.controller.signal,
        onDelta: (text) => {
          entry.text = text;
          follow(sess);
        },
      });
      if (isDeleted(sess)) return;
      const { answer, createdAt, truncated } = result;
      const turn = { id: uid(), question: result.question, answer, model, createdAt, truncated };
      sess.questions = [...questionsOf(sess), turn];
      pending.delete(sess);
      markDirty(sess); // the session record is surely on disk before its questions are read back
      store
        .putQuestion(sess.id, turn)
        .catch((err) => toast(t('toast.saveFailed', { message: err.message }), 6000, 'critical'));
    } catch (err) {
      if (isDeleted(sess)) return;
      if (entry.controller.signal.aborted) pending.delete(sess);
      else {
        entry.text = '';
        entry.error = err?.key ? errorText(err) : t('questions.failed', { message: errorText(err) });
        entry.controller = null;
      }
      giveBack(sess, question);
    }
    if (getCurrent() !== sess) return;
    const near = nearBottom();
    render();
    if (near || entry.error) toBottom();
    refocus();
  }

  function remove(sess, turn) {
    if (!confirm(t('questions.deleteConfirm', { question: quotedQuestion(turn.question) }))) return;
    sess.questions = questionsOf(sess).filter((x) => x !== turn);
    store
      .deleteQuestion(sess.id, turn.id)
      .catch((err) => toast(t('toast.saveFailed', { message: err.message }), 6000, 'critical'));
    render();
    (els.question.disabled ? els.questionsPanel : els.question).focus();
  }

  els.askForm.onsubmit = (e) => {
    e.preventDefault();
    ask();
  };
  els.question.addEventListener('keydown', (e) => {
    if (!asksOnKey(e)) return;
    e.preventDefault();
    if (!els.ask.disabled && !els.ask.hidden) ask();
  });
  els.question.addEventListener('input', () => {
    drafts.set(getCurrent(), els.question.value);
    renderControls();
  });
  els.askStop.onclick = () => pending.get(getCurrent())?.controller?.abort();

  return { render };
}
