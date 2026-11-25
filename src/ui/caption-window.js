// The caption window: shows the caption zone (`els.now`, the sentences of the run in progress) in an
// always-on-top window, so it can sit over a video call or slides. Document Picture-in-Picture in
// desktop Chrome and Edge, or a transparent overlay window opened by the desktop app (app/main.js
// makes the 'captions' window frameless and always on top). Also the caption zone's settings that
// apply wherever it is, at once (also while listening).
//
// The zone itself is moved into the window and back, not copied, so the transcript view keeps
// writing to the same elements; a comment marks its place in the page meanwhile.

import { MessageError } from './message-error.js';

const IN_DESKTOP_APP = /\bElectron\//.test(navigator.userAgent);
const CAPTION_WINDOW_NAME = 'captions'; // must match CAPTION_WINDOW in app/policy.js

// els: the page's elements; t: i18n; applyTranslations(document): applies the catalog to static
// markup; octicon(name, document): an icon; settings: the app's settings; captionKey(name): the name
// of a caption-zone setting for the languages selected; toast(message, ms, variant);
// errorText(err): an error's message; applyFontSize(): applies the text sizes of the page and of
// this window (which calls back fontSize below).
export function createCaptionWindow({
  els,
  t,
  applyTranslations,
  octicon,
  settings,
  captionKey,
  toast,
  errorText,
  applyFontSize,
}) {
  let captionWindow = null; // the window, when open
  els.pip.hidden = !('documentPictureInPicture' in window) && !IN_DESKTOP_APP;

  // Settings of the caption zone that apply wherever it is, at once (also while listening).
  function applyCaptionOptions() {
    els.now.classList.toggle('tgt-only', settings[captionKey('captionContent')] === 'tgt');
    // The desktop overlay's backdrop; a picture-in-picture window is opaque by nature.
    if (captionWindow?.document.body.classList.contains('overlay'))
      captionWindow.document.body.style.setProperty('--caption-bg-alpha', String(settings.captionOpacity / 100));
  }
  // The main process keeps the state and applies it to the overlay whenever it is open.
  function applyClickThrough() {
    window.captionOverlay?.setClickThrough(settings.clickThrough).catch(() => {});
  }
  // Opacity and click-through exist only for the desktop overlay; without any caption window,
  // its options are left out altogether.
  function showCaptionControls() {
    const anyWindow = !els.pip.hidden;
    els.captionFontSizeField.hidden = !anyWindow;
    els.captionOpacityField.hidden = !IN_DESKTOP_APP;
    els.clickThroughField.hidden = !IN_DESKTOP_APP;
    els.captionDesktopOnly.hidden = IN_DESKTOP_APP || !anyWindow;
  }
  applyCaptionOptions();
  if (settings.clickThrough) applyClickThrough();

  async function openCaptionWindow() {
    // Electron exposes documentPictureInPicture but requestWindow fails there, so check it first.
    if (IN_DESKTOP_APP) {
      const win = window.open('', CAPTION_WINDOW_NAME, 'width=720,height=220');
      if (!win) throw new MessageError('error.windowBlocked');
      return { win, overlay: true };
    }
    return { win: await window.documentPictureInPicture.requestWindow({ width: 640, height: 220 }), overlay: false };
  }

  els.pip.onclick = async () => {
    if (captionWindow) return captionWindow.close();
    let win, overlay;
    try {
      ({ win, overlay } = await openCaptionWindow());
    } catch (err) {
      return toast(t('toast.captionWindowFailed', { message: errorText(err) }), 6000, 'critical');
    }
    captionWindow = win;
    const css = win.document.createElement('link');
    css.rel = 'stylesheet';
    css.href = new URL('styles.css', location.href).href;
    win.document.head.append(css);
    win.document.title = t('caption.title');
    win.document.body.className = overlay ? 'pip overlay' : 'pip';
    // The layout that makes the zone fill the window is set inline, so it holds even if the
    // stylesheet in the new window is slow to load or an older cached copy.
    win.document.body.style.cssText = overlay
      ? 'margin:0;display:block;height:100vh;background:transparent;overflow:hidden'
      : 'margin:0;display:block;height:100vh;background:var(--bgColor-default, Canvas)';
    els.now.style.cssText = 'display:flex;width:100%;height:100vh;min-height:0;max-height:none;border-top:0';
    applyFontSize();
    applyCaptionOptions();
    const home = document.createComment('caption zone');
    els.now.before(home);
    win.document.body.append(els.now);
    let closeBtn = null;
    if (overlay) {
      // The overlay has no title bar, so it needs its own way to close.
      closeBtn = win.document.createElement('button');
      closeBtn.className = 'overlay-close icon-btn';
      closeBtn.title = t('caption.close');
      closeBtn.setAttribute('aria-label', closeBtn.title);
      closeBtn.append(octicon('x', win.document));
      closeBtn.onclick = () => win.close();
      win.document.body.append(closeBtn);
    }
    els.pip.setAttribute('aria-pressed', 'true');
    win.addEventListener(
      'pagehide',
      () => {
        closeBtn?.remove();
        els.now.style.cssText = '';
        home.replaceWith(els.now); // back to its place under the transcript
        captionWindow = null;
        els.pip.setAttribute('aria-pressed', 'false');
      },
      { once: true },
    );
  };

  return {
    applyOptions: applyCaptionOptions,
    applyClickThrough,
    showControls: showCaptionControls,
    // The window has its own text size; the main window's applies to everything else.
    fontSize() {
      captionWindow?.document.documentElement.style.setProperty('--fs', `${settings.captionFontSize}px`);
    },
    // Re-renders what the window shows that is not the caption zone, after the display language changed.
    relocalize() {
      if (!captionWindow) return;
      applyTranslations(captionWindow.document); // the caption zone lives there while it is open
      captionWindow.document.title = t('caption.title');
      const close = captionWindow.document.querySelector('.overlay-close');
      if (close) {
        close.title = t('caption.close');
        close.setAttribute('aria-label', close.title);
      }
    },
  };
}
