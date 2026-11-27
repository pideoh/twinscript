// Shared setup for the browser tests, split by topic into test/e2e/helpers/. The test files import
// everything from here:
//   app.js      the static server, setup / openApp, ready, reload, rows, saved, listening, ...
//   gemini.js   the Gemini mocks (WebSocket, token, translation), MOCK_USAGE, translated
//   targets.js  the translation mock for a third language, tagged, linesDone
//   summary.js  the summary mock
//   questions.js  the question mock, the conversation on screen, saved questions
//   tabs.js     the tabs of the main area: the one shown, showing one
//   storage.js  saved sessions read from IndexedDB
//   pc-audio.js the getDisplayMedia stand-in
//   speakers.js the recorded session and the speaker-label mocks
//   translation-errors.js  the translation mock a test answers itself, speech said on demand, a movable clock
//   updates.js  the desktop app's update bridge (window.appUpdates)

export * from './helpers/app.js';
export * from './helpers/gemini.js';
export * from './helpers/pc-audio.js';
export * from './helpers/questions.js';
export * from './helpers/speakers.js';
export * from './helpers/storage.js';
export * from './helpers/summary.js';
export * from './helpers/tabs.js';
export * from './helpers/targets.js';
export * from './helpers/translation-errors.js';
export * from './helpers/updates.js';
