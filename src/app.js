import { AudioCapture, canCaptureSystemAudio } from './audio.js';
import { GeminiLiveTranscriber } from './transcriber.js';
import { GeminiTranslator, RateLimitError } from './translator.js';
import { MockTranscriber, MockTranslator } from './mock.js';
import { UtteranceTracker } from './segmenter.js';
import { store } from './store.js';
import { Recorder, canRecord } from './recorder.js';
import { buildTranscript, formatElapsed, formatDateTime, safeFileName } from './exporter.js';

const LANGS = [
  { code: 'ja-JP', label: '日本語', name: 'Japanese' },
  { code: 'en-US', label: '英語', name: 'English' },
  { code: 'cmn-Hans-CN', label: '中国語（簡体）', name: 'Simplified Chinese' },
  { code: 'cmn-Hant-TW', label: '中国語（繁体）', name: 'Traditional Chinese' },
  { code: 'ko-KR', label: '韓国語', name: 'Korean' },
  { code: 'es-ES', label: 'スペイン語', name: 'Spanish' },
  { code: 'fr-FR', label: 'フランス語', name: 'French' },
  { code: 'de-DE', label: 'ドイツ語', name: 'German' },
  { code: 'it-IT', label: 'イタリア語', name: 'Italian' },
  { code: 'pt-BR', label: 'ポルトガル語', name: 'Portuguese' },
  { code: 'vi-VN', label: 'ベトナム語', name: 'Vietnamese' },
  { code: 'th-TH', label: 'タイ語', name: 'Thai' },
  { code: 'id-ID', label: 'インドネシア語', name: 'Indonesian' },
  { code: 'hi-IN', label: 'ヒンディー語', name: 'Hindi' },
];
const DEFAULTS = {
  langA: 'ja-JP', langB: 'en-US', source: 'mic', apiKey: '',
  translateModel: 'gemini-3.5-flash-lite', interimTranslate: true, smart: false, record: true, glossary: '', fontSize: 18,
  otherInto: 'A',       // which of the two languages a third language is translated into
  captionItems: 3,      // sentences kept in the caption zone, including the one being spoken
  interimInterval: 1.5, // seconds between re-translations of the sentence being spoken
};
const INTERIM_COOLDOWN_MS = 60_000;
const HISTORY_LINES = 3;
const MOCK = new URLSearchParams(location.search).has('mock');
const DEBUG = new URLSearchParams(location.search).has('debug'); // log raw recognizer output to the console

const $ = (id) => document.getElementById(id);
const els = Object.fromEntries([
  'langA', 'langB', 'swap', 'source', 'export', 'openSettings', 'menu', 'backdrop', 'newSession', 'sessionList',
  'clock', 'jump', 'now', 'nowList', 'pip', 'exportDialog', 'exportFormat', 'exportContent', 'exportTranscript', 'recordings', 'record', 'log', 'empty', 'anchor', 'toast',
  'dot', 'statusText', 'level', 'toggle', 'settings', 'apiKey', 'translateModel', 'interimTranslate', 'smart',
  'glossary', 'fontSize', 'otherInto', 'captionItems', 'captionItemsOut', 'interimInterval', 'interimIntervalOut', 'settingsRunning',
].map((id) => [id, $(id)]));

// ---------- settings ----------
function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('rt-settings') || '{}') }; } catch { return { ...DEFAULTS }; }
}
function saveSettings() {
  try { localStorage.setItem('rt-settings', JSON.stringify(settings)); } catch { /* private mode */ }
}
const settings = loadSettings();
let captionWindow = null; // always-on-top caption window, when open

for (const sel of [els.langA, els.langB]) {
  for (const l of LANGS) sel.add(new Option(l.label, l.code));
}
els.langA.value = settings.langA;
els.langB.value = settings.langB;
if (!canCaptureSystemAudio()) {
  els.source.querySelectorAll('option:not([value=mic])').forEach((o) => o.remove());
  settings.source = 'mic';
}
els.source.value = settings.source;
applyFontSize();

function applyFontSize() {
  document.documentElement.style.setProperty('--fs', `${settings.fontSize}px`);
  captionWindow?.document.documentElement.style.setProperty('--fs', `${settings.fontSize}px`);
}
function onLangChange(changed, other) {
  if (changed.value === other.value) other.value = changed === els.langA ? settings.langB : settings.langA;
  if (changed.value === other.value) other.value = LANGS.find((l) => l.code !== changed.value).code;
  langsChanged();
}
function langsChanged() {
  settings.langA = els.langA.value;
  settings.langB = els.langB.value;
  saveSettings();
  if (current) {
    current.langA = settings.langA;
    current.langB = settings.langB;
    markDirty(current);
  }
}
els.langA.onchange = () => onLangChange(els.langA, els.langB);
els.langB.onchange = () => onLangChange(els.langB, els.langA);
els.swap.onclick = () => {
  [els.langA.value, els.langB.value] = [els.langB.value, els.langA.value];
  langsChanged();
};
els.source.onchange = () => { settings.source = els.source.value; saveSettings(); };

els.openSettings.onclick = openSettings;
function openSettings() {
  els.apiKey.value = settings.apiKey;
  els.translateModel.value = settings.translateModel;
  els.interimTranslate.checked = settings.interimTranslate;
  els.smart.checked = settings.smart;
  els.record.checked = settings.record;
  els.glossary.value = settings.glossary;
  els.fontSize.value = settings.fontSize;
  els.otherInto.options[0].text = `${langLabel(settings.langA)}（左の言語）`;
  els.otherInto.options[1].text = `${langLabel(settings.langB)}（右の言語）`;
  els.otherInto.value = settings.otherInto;
  els.captionItems.value = settings.captionItems;
  els.interimInterval.value = settings.interimInterval;
  showTuning();
  els.settingsRunning.hidden = !run;
  els.settings.showModal();
}
els.fontSize.oninput = () => { settings.fontSize = Number(els.fontSize.value); applyFontSize(); };
// These apply immediately, so they can be tuned while listening.
function showTuning() {
  els.captionItemsOut.textContent = `${els.captionItems.value} 文`;
  els.interimIntervalOut.textContent = `${Number(els.interimInterval.value).toFixed(1)} 秒`;
}
els.captionItems.oninput = () => { settings.captionItems = Number(els.captionItems.value); showTuning(); trimCaptions(); };
els.interimInterval.oninput = () => { settings.interimInterval = Number(els.interimInterval.value); showTuning(); };
els.settings.addEventListener('close', () => {
  settings.apiKey = els.apiKey.value.trim();
  settings.translateModel = els.translateModel.value.trim() || DEFAULTS.translateModel;
  settings.interimTranslate = els.interimTranslate.checked;
  settings.smart = els.smart.checked;
  settings.record = els.record.checked;
  settings.glossary = els.glossary.value.trim();
  settings.fontSize = Number(els.fontSize.value);
  settings.otherInto = els.otherInto.value;
  settings.captionItems = Number(els.captionItems.value);
  settings.interimInterval = Number(els.interimInterval.value);
  saveSettings();
});

// ---------- sessions (saved conversations) ----------
// { id, title, customTitle, createdAt, updatedAt, langA, langB, activeMs,
//   segments: [{ id, at, elapsed, src, tgt }], recordings: [{ id, startedAt, elapsedStart, durationMs, mime }] }
let sessions = [];   // saved sessions, newest first
let current = null;  // the session on screen
let run = null;      // the live capture/translation in progress, if any
let live = null;     // segment currently being spoken
let toastTimer;
const dirty = new Set();
let saveTimer;

const uid = () => crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const isEmpty = (sess) => !sess.segments.length && !sess.recordings.length;
const langLabel = (code) => LANGS.find((l) => l.code === code)?.label ?? code;

function toast(message, ms = 6000) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, ms);
}

function blankSession() {
  const now = Date.now();
  return {
    id: uid(), title: '', customTitle: false, createdAt: now, updatedAt: now,
    langA: settings.langA, langB: settings.langB, activeMs: 0, segments: [], recordings: [],
  };
}

const serialize = (sess) => ({
  ...sess,
  segments: sess.segments.map(({ id, at, elapsed, src, tgt }) => ({ id, at, elapsed, src, tgt })),
});

function markDirty(sess) {
  dirty.add(sess);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSaves, 250);
}

function flushSaves() {
  clearTimeout(saveTimer);
  for (const sess of dirty) {
    if (isEmpty(sess)) continue; // don't litter the list with untouched sessions
    if (run?.session === sess) {
      sess.activeMs = elapsedNow();
      if (run.recording) run.recording.durationMs = Date.now() - run.recording.startedAt;
    }
    sess.updatedAt = Date.now();
    if (!sess.customTitle) sess.title = sess.segments[0]?.src.slice(0, 30) || formatDateTime(sess.createdAt);
    if (!sessions.includes(sess)) {
      sessions.unshift(sess);
      store.requestPersistence();
    }
    store.saveSession(serialize(sess)).catch((err) => toast(`保存に失敗しました: ${err.message}`));
  }
  dirty.clear();
  renderSidebar();
}
window.addEventListener('pagehide', flushSaves);

function showSession(sess) {
  current = sess;
  try { localStorage.setItem('rt-current', sess.id); } catch { /* private mode */ }
  els.log.querySelectorAll('.seg').forEach((n) => n.remove());
  live = null;
  for (const seg of sess.segments) mountSegment(seg);
  els.empty.hidden = sess.segments.length > 0;
  if (LANGS.some((l) => l.code === sess.langA) && LANGS.some((l) => l.code === sess.langB) && sess.langA !== sess.langB) {
    els.langA.value = settings.langA = sess.langA;
    els.langB.value = settings.langB = sess.langB;
    saveSettings();
  }
  els.clock.textContent = formatElapsed(sess.activeMs);
  els.log.scrollTop = els.log.scrollHeight;
  document.body.classList.remove('drawer');
  renderSidebar();
}

function renderSidebar() {
  els.sessionList.replaceChildren(...sessions.map((sess) => {
    const row = document.createElement('div');
    row.className = `session${sess === current ? ' current' : ''}`;
    const open = document.createElement('button');
    open.className = 'open';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = sess.title;
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = `${formatDateTime(sess.createdAt)} ・ ${formatElapsed(sess.activeMs)}`;
    open.append(name, when);
    open.onclick = () => { if (canSwitch()) showSession(sess); };
    const action = (label, title, fn) => {
      const b = document.createElement('button');
      b.className = 'act';
      b.textContent = label;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.onclick = fn;
      return b;
    };
    row.append(open, action('✎', '名前を変更', () => renameSession(sess)), action('✕', '削除', () => deleteSession(sess)));
    return row;
  }));
}

function canSwitch() {
  if (run) toast('翻訳を停止してから切り替えてください');
  return !run;
}

function renameSession(sess) {
  const title = prompt('セッション名', sess.title)?.trim();
  if (!title) return;
  sess.title = title;
  sess.customTitle = true;
  markDirty(sess);
}

async function deleteSession(sess) {
  if (run?.session === sess) return toast('翻訳を停止してから削除してください');
  if (!confirm(`「${sess.title}」を削除しますか？文字起こしと録音が消えます。`)) return;
  dirty.delete(sess);
  sessions = sessions.filter((x) => x !== sess);
  await store.deleteSession(sess.id).catch((err) => toast(`削除に失敗しました: ${err.message}`));
  if (sess === current) showSession(sessions[0] ?? blankSession());
  else renderSidebar();
}

els.newSession.onclick = () => { if (canSwitch()) showSession(blankSession()); };
els.menu.onclick = () => document.body.classList.toggle('drawer');
els.backdrop.onclick = () => document.body.classList.remove('drawer');

// ---------- transcript view ----------
function nearBottom() {
  return els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < 120;
}
function keepBottom(wasNear) {
  if (wasNear) els.log.scrollTop = els.log.scrollHeight;
}

// Builds the DOM for a segment (new or loaded from storage) and attaches it to the segment object.
function mountSegment(seg, isLive = false) {
  const el = document.createElement('div');
  el.className = `seg${isLive ? ' live' : ''}`;
  const timeEl = document.createElement('div');
  timeEl.className = 'time';
  timeEl.textContent = formatElapsed(seg.elapsed);
  const srcEl = document.createElement('div');
  srcEl.className = 'src';
  srcEl.textContent = seg.src;
  const tgtEl = document.createElement('div');
  tgtEl.className = `tgt${isLive ? ' pending' : ''}`;
  tgtEl.textContent = seg.tgt;
  el.append(timeEl, srcEl, tgtEl);
  els.empty.hidden = true;
  Object.assign(seg, { el, srcEl, tgtEl });
  if (run) {
    els.nowList.append(el);
    trimCaptions();
  } else {
    els.log.insertBefore(el, els.anchor);
  }
  return seg;
}

// Moves the oldest sentences out of the caption zone into the transcript.
function trimCaptions(keep = settings.captionItems) {
  const wasNear = nearBottom();
  while (els.nowList.children.length > keep) els.log.insertBefore(els.nowList.firstElementChild, els.anchor);
  keepBottom(wasNear);
  updateJump();
}

function createSegment() {
  return mountSegment({ id: uid(), at: Date.now(), elapsed: elapsedNow(), src: '', tgt: '' }, true);
}

function setText(seg, part, text, cls) {
  const wasNear = nearBottom();
  const node = part === 'src' ? seg.srcEl : seg.tgtEl;
  node.textContent = text;
  if (part === 'tgt') node.className = `tgt${cls ? ` ${cls}` : ''}`;
  keepBottom(wasNear);
  updateJump();
}

// Offer a way back to the latest sentence while the user has scrolled up to re-read.
function updateJump() {
  els.jump.hidden = nearBottom();
}
els.log.addEventListener('scroll', updateJump, { passive: true });
els.jump.onclick = () => { els.log.scrollTop = els.log.scrollHeight; };

// ---------- caption window ----------
// Shows the caption zone in an always-on-top window (Document Picture-in-Picture; desktop Chrome
// and Edge), so it can sit over a video call or slides.
els.pip.hidden = !('documentPictureInPicture' in window);
els.pip.onclick = async () => {
  if (captionWindow) return captionWindow.close();
  let win;
  try {
    win = await window.documentPictureInPicture.requestWindow({ width: 640, height: 220 });
  } catch (err) {
    return toast(`字幕ウィンドウを開けませんでした: ${err.message}`);
  }
  captionWindow = win;
  const css = win.document.createElement('link');
  css.rel = 'stylesheet';
  css.href = new URL('styles.css', location.href).href;
  win.document.head.append(css);
  win.document.title = '字幕';
  win.document.body.className = 'pip';
  // The layout that makes the zone fill the window is set inline, so it holds even if the
  // stylesheet in the new window is slow to load or an older cached copy.
  win.document.body.style.cssText = 'margin:0;display:block;height:100vh;background:var(--panel, #131c2e)';
  els.now.style.cssText = 'display:flex;width:100%;height:100vh;min-height:0;max-height:none;border-top:0';
  applyFontSize();
  const home = document.createComment('caption zone');
  els.now.before(home);
  win.document.body.append(els.now);
  els.pip.setAttribute('aria-pressed', 'true');
  win.addEventListener('pagehide', () => {
    els.now.style.cssText = '';
    home.replaceWith(els.now); // back to its place under the transcript
    captionWindow = null;
    els.pip.setAttribute('aria-pressed', 'false');
  }, { once: true });
};

// ---------- download ----------
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

els.export.onclick = () => {
  if (isEmpty(current)) return toast('保存する内容がありません');
  flushSaves(); // so the title and recording lengths are up to date
  const sess = current;
  const rows = sess.recordings.map((rec, i) => {
    const row = document.createElement('div');
    row.className = 'rec';
    const info = document.createElement('span');
    const length = run?.recording === rec ? '録音中' : formatElapsed(rec.durationMs);
    info.textContent = `録音 ${i + 1} ・ ${formatDateTime(rec.startedAt)} ・ ${length}`;
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'plain';
    save.textContent = '保存';
    save.onclick = async () => {
      const chunks = await store.getAudioChunks(sess.id, rec.id).catch(() => []);
      if (!chunks.length) return toast('この録音のデータが見つかりません');
      const ext = rec.mime.includes('mp4') ? 'm4a' : 'webm';
      download(new Blob(chunks, { type: rec.mime }), `${safeFileName(sess.title)}-${i + 1}.${ext}`);
    };
    row.append(info, save);
    return row;
  });
  if (rows.length) {
    const heading = document.createElement('h3');
    heading.textContent = '録音';
    rows.unshift(heading);
  }
  els.recordings.replaceChildren(...rows);
  els.exportDialog.showModal();
};

els.exportTranscript.onclick = () => {
  if (!current.segments.length) return toast('文字起こしがまだありません');
  const { text, ext, mime } = buildTranscript(serialize(current), {
    format: els.exportFormat.value, content: els.exportContent.value, langLabel,
  });
  download(new Blob([text], { type: `${mime};charset=utf-8` }), `${safeFileName(current.title)}.${ext}`);
};

// ---------- live run ----------
let wakeLock = null;

// Active (recording) time of the current session, which is what segment timestamps show.
function elapsedNow() {
  return run?.startedAt ? run.baseMs + Date.now() - run.startedAt : current.activeMs;
}

function setStatus(state) {
  const map = {
    idle: ['', '停止中'],
    connecting: ['busy', '接続中…'],
    listening: ['on', '聞き取り中'],
    reconnecting: ['busy', '再接続中…'],
  };
  const [cls, text] = map[state];
  els.dot.className = `dot ${cls}`;
  els.statusText.textContent = text;
}

function setRunning(running) {
  els.toggle.textContent = running ? '停止' : '翻訳開始';
  els.toggle.classList.toggle('stop', running);
  document.body.classList.toggle('running', running);
  els.now.hidden = !running;
  for (const el of [els.langA, els.langB, els.swap, els.source, els.newSession]) el.disabled = running;
  if (!running) { setStatus('idle'); els.level.style.width = '0'; }
}

els.toggle.onclick = () => (run ? stop() : start());

async function start() {
  if (!MOCK && !settings.apiKey) {
    toast('最初に Gemini APIキーを設定してください');
    return openSettings();
  }
  const langA = LANGS.find((l) => l.code === settings.langA);
  const langB = LANGS.find((l) => l.code === settings.langB);
  const sess = current;
  sess.langA = langA.code;
  sess.langB = langB.code;
  const r = {
    session: sess, baseMs: sess.activeMs, startedAt: 0,
    interim: { busy: false, lastAt: 0, pausedUntil: 0, timer: null, text: '' },
  };
  r.tracker = createTracker(r);
  run = r;
  setRunning(true);
  setStatus('connecting');

  const handlers = {
    onInterim: (text) => { if (DEBUG) console.log('[interim]', text); if (run === r) r.tracker.interim(text); },
    onFinal: (text) => { if (DEBUG) console.log('[final]', text); if (run === r) r.tracker.final(text); },
    onState: (state) => run === r && setStatus(state),
    onError: (err) => { if (run === r) { toast(err.message, 10000); stop(); } },
  };
  if (MOCK) {
    r.translator = new MockTranslator();
    r.transcriber = new MockTranscriber(handlers);
  } else {
    r.translator = new GeminiTranslator({
      apiKey: settings.apiKey, model: settings.translateModel,
      langA: langA.name, langB: langB.name, glossary: settings.glossary,
      otherInto: (settings.otherInto === 'B' ? langB : langA).name,
    });
    r.transcriber = new GeminiLiveTranscriber({
      apiKey: settings.apiKey, languageCodes: [langA.code, langB.code], smart: settings.smart, ...handlers,
    });
  }

  try {
    if (!MOCK) {
      r.capture = new AudioCapture({
        onChunk: (b64) => r.transcriber.sendAudio(b64),
        onLevel: (rms) => { els.level.style.width = `${Math.min(100, rms * 400)}%`; },
        onEnded: () => { if (run === r) { toast('音声入力が終了しました'); stop(); } },
      });
      await r.capture.start(settings.source);
      if (run !== r) return r.capture.stop(); // stopped while the permission prompt was open
    }
    r.startedAt = Date.now();
    if (!MOCK && settings.record && canRecord()) startRecording(r);
    r.transcriber.start();
    r.ticker = setInterval(() => { els.clock.textContent = formatElapsed(elapsedNow()); }, 500);
    r.autosave = setInterval(() => markDirty(sess), 5000); // keeps elapsed time and recording length current
    requestWakeLock();
  } catch (err) {
    if (run !== r) return;
    const denied = err.name === 'NotAllowedError' || err.name === 'SecurityError';
    toast(denied ? 'マイク/画面共有の許可が必要です。ブラウザの設定を確認してください。' : err.message, 10000);
    stop();
  }
}

function startRecording(r) {
  const sess = r.session;
  const rec = { id: uid(), startedAt: r.startedAt, elapsedStart: r.baseMs, durationMs: 0, mime: '' };
  try {
    r.recorder = new Recorder(r.capture.stream, (blob) => {
      store.addAudioChunk(sess.id, rec.id, blob).catch(() => {
        if (!r.recordWarned) toast('録音を保存できませんでした（空き容量を確認してください）');
        r.recordWarned = true;
      });
    });
    rec.mime = r.recorder.mime;
    r.recorder.start();
    r.recording = rec;
    sess.recordings.push(rec);
    markDirty(sess);
  } catch {
    toast('このブラウザでは録音できないため、文字起こしのみ行います');
  }
}

function stop() {
  const r = run;
  if (!r) return;
  r.transcriber?.stop();
  r.tracker.flush(); // keep whatever was heard so far instead of dropping it
  if (live) { live.el.remove(); live = null; }
  trimCaptions(0);
  clearTimeout(r.interim.timer);
  clearInterval(r.ticker);
  clearInterval(r.autosave);
  if (r.startedAt) r.session.activeMs = elapsedNow();
  if (r.recording) r.recording.durationMs = Date.now() - r.recording.startedAt;
  run = null;
  // Let the recorder hand over its last chunk before the audio graph is torn down.
  const release = () => r.capture?.stop();
  if (r.recorder) r.recorder.stop().then(release, release); else release();
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  setRunning(false);
  els.clock.textContent = formatElapsed(r.session.activeMs);
  markDirty(r.session);
}

async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* unsupported or denied */ }
}
document.addEventListener('visibilitychange', () => {
  if (run && document.visibilityState === 'visible') requestWakeLock();
});

// ---------- transcript + translation flow ----------
function createTracker(r) {
  return new UtteranceTracker({
    commit(text, aboveLive) {
      if (aboveLive) {
        const seg = createSegment();
        if (live) live.el.before(seg.el);
        commit(r, seg, text);
        return seg;
      }
      if (!live) live = createSegment();
      return finalize(r, text);
    },
    setLive(text) {
      if (!text) {
        live?.el.remove();
        live = null;
        clearTimeout(r.interim.timer);
        r.interim.timer = null;
        r.interim.text = '';
        return;
      }
      if (!live) live = createSegment();
      setText(live, 'src', text);
      r.interim.text = text;
      scheduleInterimTranslation(r);
    },
    correct: (seg, text) => commit(r, seg, text),
  });
}

function scheduleInterimTranslation(s) {
  const it = s.interim;
  if (!settings.interimTranslate || it.busy || it.timer || !live) return;
  const now = Date.now();
  if (now < it.pausedUntil) return;
  const wait = Math.max(0, it.lastAt + settings.interimInterval * 1000 - now);
  it.timer = setTimeout(async () => {
    it.timer = null;
    const seg = live;
    const text = it.text;
    if (run !== s || !seg || text.length < 4) return;
    it.busy = true;
    it.lastAt = Date.now();
    try {
      const out = await s.translator.translate(text, { history: recentHistory(s) });
      if (seg === live && out) setText(seg, 'tgt', out, 'pending');
    } catch (err) {
      if (err instanceof RateLimitError) {
        it.pausedUntil = Date.now() + INTERIM_COOLDOWN_MS;
        toast('レート制限のため、途中経過の翻訳を1分間停止します（確定文の翻訳は継続）');
      }
    } finally {
      it.busy = false;
      if (run === s && live === seg && it.text !== text) scheduleInterimTranslation(s);
    }
  }, wait);
}

function finalize(r, text) {
  const seg = live;
  live = null;
  clearTimeout(r.interim.timer);
  r.interim.timer = null;
  r.interim.text = '';
  commit(r, seg, text);
  return seg;
}

function commit(r, seg, text) {
  seg.el.classList.remove('live');
  seg.src = text;
  setText(seg, 'src', text);
  if (!r.session.segments.includes(seg)) r.session.segments.push(seg);
  markDirty(r.session);
  translateFinal(r, seg);
}

function recentHistory(r) {
  return r.session.segments.filter((x) => x.tgt).slice(-HISTORY_LINES).map(({ src, tgt }) => ({ src, tgt }));
}

async function translateFinal(r, seg) {
  const history = recentHistory(r);
  const rev = seg.rev = (seg.rev || 0) + 1; // a segment can be re-translated when its text is corrected
  const shown = () => seg.rev === rev && seg.el.isConnected;
  // If a translation of the in-progress text is already on screen, swap it once when the final one
  // is complete rather than replacing it with a few words that grow again.
  const swapWhenDone = !!seg.tgtEl.textContent;
  for (let attempt = 0; ; attempt++) {
    try {
      const out = await r.translator.translate(seg.src, {
        history,
        onDelta: (partial) => { if (shown() && !swapWhenDone) setText(seg, 'tgt', partial); },
      });
      if (seg.rev !== rev) return;
      seg.tgt = out;
      if (shown()) setText(seg, 'tgt', out);
      markDirty(r.session);
      return;
    } catch (err) {
      if (err instanceof RateLimitError && attempt < 3) {
        await new Promise((res) => setTimeout(res, 1500 * 2 ** attempt));
        continue;
      }
      if (shown()) setText(seg, 'tgt', err.message, 'error');
      return;
    }
  }
}

// ---------- startup ----------
try {
  sessions = (await store.listSessions()).sort((a, b) => b.createdAt - a.createdAt);
} catch {
  toast('ブラウザの保存領域が使えないため、このタブを閉じると内容は消えます');
}
let lastId = null;
try { lastId = localStorage.getItem('rt-current'); } catch { /* private mode */ }
showSession(sessions.find((x) => x.id === lastId) ?? blankSession());
if (MOCK) toast('デモモード: 実際の音声認識・翻訳は行いません', 4000);
