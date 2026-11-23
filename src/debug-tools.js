// Tuning tools that exist only with ?debug=1: an audio file as the input, and saving the trace of
// what the recognizer delivered (src/trace.js). Kept out of app.js, which only wires them in.
import { t } from './i18n.js';
import { octicon } from './icons.js';
import { traceFileName } from './trace.js';

export const FILE_TAIL_MS = 2000; // after a file ends, how long the run waits for the last final result

// Adds "Audio file (debug)" to the audio input select.
export function addFileSourceOption(select) {
  const option = document.createElement('option');
  option.value = 'file';
  option.dataset.i18n = 'source.file';
  option.textContent = t('source.file');
  select.append(option);
}

// Opens a file picker; resolves with the chosen file, or null when the picker is cancelled.
// Call it before any await in the click handler, while the click still counts as user activation.
export function pickAudioFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*,video/webm,video/mp4';
    input.addEventListener('change', () => resolve(input.files[0] ?? null), { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
}

// The download dialog's entry for the last trace.
export function traceDownloadButton(trace, download) {
  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'saveTrace';
  button.className = 'btn';
  const label = document.createElement('span');
  label.textContent = t('export.trace');
  button.append(octicon('download'), label);
  button.onclick = () =>
    download(
      new Blob([`${JSON.stringify(trace, null, 2)}\n`], { type: 'application/json' }),
      traceFileName(new Date(trace.startedAt)),
    );
  return button;
}
