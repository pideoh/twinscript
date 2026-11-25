---
name: add-locale
description: Add a new display language to Twinscript (the app's own UI text), or review an existing translation. Use when asked to add, update or check a UI language.
---

# Add a display language

1. Pick the locale id (BCP 47, e.g. `ko`, `de`, `pt-BR`). Copy `src/locales/en.js` to `src/locales/<id>.js`.
2. Translate every value. Keep the keys and the `{placeholders}` exactly as they are. Set `language.name` to the language's own name (e.g. `한국어`).
   - Translate for a product UI: short, natural, consistent terms for the same thing (session, transcript, caption, PC audio).
   - Operating-system paths (the macOS privacy settings) must match the labels the OS shows in that language. If you cannot confirm them, keep the English labels and say so.
3. Register the language in the `LOCALES` array in `src/i18n.js`, with the browser language tags that should select it automatically.
4. Run `node --test test/unit/rules/i18n.test.js`. It fails on a missing key or placeholder.
5. Check that the text fits: `node scripts/screenshots.mjs <dir> lang-<id>` and look at the main screen and the settings dialog. Fix overflow by shortening the text, not by changing the layout.
6. Add a line to `test/e2e/shell.e2e.js` only if the language needs special handling (e.g. right-to-left); the existing tests already cover switching.
7. In the pull request, state whether a native speaker reviewed the translation.
