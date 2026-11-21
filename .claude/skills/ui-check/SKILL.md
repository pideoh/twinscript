---
name: ui-check
description: Capture and review screenshots of Twinscript after a visual change (styles.css, index.html, icons, UI text). Use to verify layout, themes and languages before opening a pull request.
---

# Check a visual change

1. Capture: `node scripts/screenshots.mjs <dir> [filter]` (write into a temporary directory, not the repository). It uses the demo mode, so no API key or microphone is needed. Without a filter it produces desktop and phone views, light and dark, the settings and download dialogs, and the main screen plus settings in every other display language.
2. Look at every image you produced. Check:
   - nothing is clipped, overlapping or wrapping badly, at 1280px and at 390px;
   - light and dark both read well; no element kept a color from the other theme;
   - the caption area at the bottom shows the sentence in progress and the finished ones above it;
   - dialogs: header, scrolling body, footer buttons aligned right;
   - other languages: labels and buttons fit.
3. Run `npm test` (the design-token test catches literal colors and Unicode icons) and `npm run test:e2e`.
4. If the change is visible on the main screen, refresh the README image: copy `desktop-light-listening.png` to `docs/screenshot.png`.
5. Things this does not cover, to mention in the pull request if relevant: real Safari and iPhone, the browser picture-in-picture window, and the desktop caption overlay (`npm run test:app` opens it).
