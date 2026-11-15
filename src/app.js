import { AudioCapture, canCaptureSystemAudio } from './audio.js';
import { GeminiLiveTranscriber } from './transcriber.js';
import { GeminiTranslator, RateLimitError } from './translator.js';
import { MockTranscriber, MockTranslator } from './mock.js';

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
  translateModel: 'gemini-3.5-flash-lite', interimTranslate: true, smart: false, glossary: '', fontSize: 18,
};
const INTERIM_TRANSLATE_INTERVAL_MS = 1200;
const INTERIM_COOLDOWN_MS = 60_000;
const HISTORY_LINES = 3;
const MOCK = new URLSearchParams(location.search).has('mock');

const $ = (id) => document.getElementById(id);
const els = Object.fromEntries([
  'langA', 'langB', 'swap', 'source', 'export', 'clear', 'openSettings', 'log', 'empty', 'anchor', 'toast',
  'dot', 'statusText', 'level', 'toggle', 'settings', 'apiKey', 'translateModel', 'interimTranslate', 'smart',
  'glossary', 'fontSize',
].map((id) => [id, $(id)]));

// ---------- settings ----------
function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('rt-settings') || '{}') }; } catch { return { ...DEFAULTS }; }
}
function saveSettings() {
  try { localStorage.setItem('rt-settings', JSON.stringify(settings)); } catch { /* private mode */ }
}
const settings = loadSettings();

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
}
function onLangChange(changed, other) {
  if (changed.value === other.value) other.value = changed === els.langA ? settings.langB : settings.langA;
  if (changed.value === other.value) other.value = LANGS.find((l) => l.code !== changed.value).code;
  settings.langA = els.langA.value;
  settings.langB = els.langB.value;
  saveSettings();
}
els.langA.onchange = () => onLangChange(els.langA, els.langB);
els.langB.onchange = () => onLangChange(els.langB, els.langA);
els.swap.onclick = () => {
  [els.langA.value, els.langB.value] = [els.langB.value, els.langA.value];
  settings.langA = els.langA.value;
  settings.langB = els.langB.value;
  saveSettings();
};
els.source.onchange = () => { settings.source = els.source.value; saveSettings(); };

els.openSettings.onclick = openSettings;
function openSettings() {
  els.apiKey.value = settings.apiKey;
  els.translateModel.value = settings.translateModel;
  els.interimTranslate.checked = settings.interimTranslate;
  els.smart.checked = settings.smart;
  els.glossary.value = settings.glossary;
  els.fontSize.value = settings.fontSize;
  els.settings.showModal();
}
els.fontSize.oninput = () => { settings.fontSize = Number(els.fontSize.value); applyFontSize(); };
els.settings.addEventListener('close', () => {
  settings.apiKey = els.apiKey.value.trim();
  settings.translateModel = els.translateModel.value.trim() || DEFAULTS.translateModel;
  settings.interimTranslate = els.interimTranslate.checked;
  settings.smart = els.smart.checked;
  settings.glossary = els.glossary.value.trim();
  settings.fontSize = Number(els.fontSize.value);
  saveSettings();
});

// ---------- transcript view ----------
const segments = []; // finalized: { src, tgt }
let live = null;     // segment currently being spoken: { el, srcEl, tgtEl }
let toastTimer;

function toast(message, ms = 6000) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, ms);
}

function nearBottom() {
  return els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < 120;
}
function keepBottom(wasNear) {
  if (wasNear) els.log.scrollTop = els.log.scrollHeight;
}

function createSegment() {
  const el = document.createElement('div');
  el.className = 'seg live';
  const srcEl = document.createElement('div');
  srcEl.className = 'src';
  const tgtEl = document.createElement('div');
  tgtEl.className = 'tgt pending';
  el.append(srcEl, tgtEl);
  els.empty.hidden = true;
  els.log.insertBefore(el, els.anchor);
  return { el, srcEl, tgtEl, src: '', tgt: '' };
}

function setText(seg, part, text, cls) {
  const wasNear = nearBottom();
  const node = part === 'src' ? seg.srcEl : seg.tgtEl;
  node.textContent = text;
  if (part === 'tgt') node.className = `tgt${cls ? ` ${cls}` : ''}`;
  keepBottom(wasNear);
}

els.clear.onclick = () => {
  if (segments.length && !confirm('表示中の内容をすべて消去しますか？')) return;
  els.log.querySelectorAll('.seg').forEach((n) => n.remove());
  segments.length = 0;
  live = null;
  els.empty.hidden = false;
};

els.export.onclick = () => {
  if (!segments.length) return toast('保存する内容がありません');
  const text = segments.map((s) => `${s.src}\n${s.tgt}`).join('\n\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = `translation-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
};

// ---------- session ----------
let session = null; // { capture, transcriber, translator, interim: {...} }
let wakeLock = null;

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
  for (const el of [els.langA, els.langB, els.swap, els.source, els.openSettings]) el.disabled = running;
  if (!running) { setStatus('idle'); els.level.style.width = '0'; }
}

els.toggle.onclick = () => (session ? stop() : start());

async function start() {
  if (!MOCK && !settings.apiKey) {
    toast('最初に Gemini APIキーを設定してください');
    return openSettings();
  }
  const langA = LANGS.find((l) => l.code === settings.langA);
  const langB = LANGS.find((l) => l.code === settings.langB);
  const s = { interim: { busy: false, lastAt: 0, pausedUntil: 0, timer: null, text: '' } };
  session = s;
  setRunning(true);
  setStatus('connecting');

  const handlers = {
    onInterim: (text) => session === s && handleInterim(s, text),
    onFinal: (text) => session === s && handleFinal(s, text),
    onState: (state) => session === s && setStatus(state),
    onError: (err) => { if (session === s) { toast(err.message, 10000); stop(); } },
  };
  if (MOCK) {
    s.translator = new MockTranslator();
    s.transcriber = new MockTranscriber(handlers);
  } else {
    s.translator = new GeminiTranslator({
      apiKey: settings.apiKey, model: settings.translateModel,
      langA: langA.name, langB: langB.name, glossary: settings.glossary,
    });
    s.transcriber = new GeminiLiveTranscriber({
      apiKey: settings.apiKey, languageCodes: [langA.code, langB.code], smart: settings.smart, ...handlers,
    });
  }

  try {
    if (!MOCK) {
      s.capture = new AudioCapture({
        onChunk: (b64) => s.transcriber.sendAudio(b64),
        onLevel: (rms) => { els.level.style.width = `${Math.min(100, rms * 400)}%`; },
        onEnded: () => { if (session === s) { toast('音声入力が終了しました'); stop(); } },
      });
      await s.capture.start(settings.source);
      if (session !== s) return s.capture.stop(); // stopped while the permission prompt was open
    }
    s.transcriber.start();
    requestWakeLock();
  } catch (err) {
    if (session !== s) return;
    const denied = err.name === 'NotAllowedError' || err.name === 'SecurityError';
    toast(denied ? 'マイク/画面共有の許可が必要です。ブラウザの設定を確認してください。' : err.message, 10000);
    stop();
  }
}

function stop() {
  const s = session;
  if (!s) return;
  session = null;
  clearTimeout(s.interim.timer);
  s.capture?.stop();
  s.transcriber?.stop();
  if (live) {
    // Keep whatever was heard so far instead of dropping it.
    if (live.srcEl.textContent.trim()) finalize(s, live.srcEl.textContent.trim());
    else { live.el.remove(); live = null; }
  }
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  setRunning(false);
}

async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* unsupported or denied */ }
}
document.addEventListener('visibilitychange', () => {
  if (session && document.visibilityState === 'visible') requestWakeLock();
});

// ---------- transcript + translation flow ----------
function handleInterim(s, text) {
  if (!live) live = createSegment();
  setText(live, 'src', text);
  s.interim.text = text;
  scheduleInterimTranslation(s);
}

function scheduleInterimTranslation(s) {
  const it = s.interim;
  if (!settings.interimTranslate || it.busy || it.timer || !live) return;
  const now = Date.now();
  if (now < it.pausedUntil) return;
  const wait = Math.max(0, it.lastAt + INTERIM_TRANSLATE_INTERVAL_MS - now);
  it.timer = setTimeout(async () => {
    it.timer = null;
    const seg = live;
    const text = it.text;
    if (session !== s || !seg || text.length < 4) return;
    it.busy = true;
    it.lastAt = Date.now();
    try {
      const out = await s.translator.translate(text, { history: recentHistory() });
      if (seg === live && out) setText(seg, 'tgt', out, 'pending');
    } catch (err) {
      if (err instanceof RateLimitError) {
        it.pausedUntil = Date.now() + INTERIM_COOLDOWN_MS;
        toast('レート制限のため、途中経過の翻訳を1分間停止します（確定文の翻訳は継続）');
      }
    } finally {
      it.busy = false;
      if (session === s && live === seg && it.text !== text) scheduleInterimTranslation(s);
    }
  }, wait);
}

function handleFinal(s, text) {
  if (!live) live = createSegment();
  finalize(s, text);
}

function finalize(s, text) {
  const seg = live;
  live = null;
  clearTimeout(s.interim.timer);
  s.interim.timer = null;
  s.interim.text = '';
  seg.el.classList.remove('live');
  seg.src = text;
  setText(seg, 'src', text);
  segments.push(seg);
  translateFinal(s, seg);
}

function recentHistory() {
  return segments.filter((x) => x.tgt).slice(-HISTORY_LINES).map(({ src, tgt }) => ({ src, tgt }));
}

async function translateFinal(s, seg) {
  const history = recentHistory();
  for (let attempt = 0; ; attempt++) {
    try {
      const out = await s.translator.translate(seg.src, {
        history,
        onDelta: (partial) => setText(seg, 'tgt', partial),
      });
      seg.tgt = out;
      setText(seg, 'tgt', out);
      return;
    } catch (err) {
      if (err instanceof RateLimitError && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
        continue;
      }
      setText(seg, 'tgt', err.message, 'error');
      return;
    }
  }
}

if (MOCK) toast('デモモード: 実際の音声認識・翻訳は行いません', 4000);
