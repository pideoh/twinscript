// Shared setup for the browser tests, split by topic into test/e2e/helpers/. The test files import
// everything from here:
//   audio-reader.js  audio files read in pieces against a whole-file decode: test files, the comparison
//   app.js      the static server, setup / openApp, ready, reload, rows, saved, listening, ...
//   gemini.js   the Gemini mocks (WebSocket, token, translation), MOCK_USAGE, translated
//   targets.js  the translation mock for a third language, tagged, linesDone
//   summary.js  the summary mock
//   questions.js  the question mock, the conversation on screen, saved questions
//   tabs.js     the tabs of the main area: the one shown, showing one
//   listening.js  choosing the languages and the audio input in the bottom bar's popover
//   storage.js  saved sessions read from IndexedDB
//   pc-audio.js the getDisplayMedia stand-in
//   speakers.js the recorded session and the speaker-label mocks
//   import.js   a session made from an audio file: WAV files, choosing one, the stored audio
//   import-languages.js  the languages chosen in the import dialog, and the listening choice beside them
//   rebuild.js  a transcript rebuilt from the recording: its answer, the named session, translation, the kept transcript
//   translation-errors.js  the translation mock a test answers itself, speech said on demand, a movable clock
//   updates.js  the desktop app's update bridge (window.appUpdates)

export * from './helpers/app.js';
export * from './helpers/audio-reader.js';
export * from './helpers/gemini.js';
export * from './helpers/import.js';
export * from './helpers/import-languages.js';
export * from './helpers/listening.js';
export * from './helpers/pc-audio.js';
export * from './helpers/questions.js';
export * from './helpers/rebuild.js';
export * from './helpers/speakers.js';
export * from './helpers/storage.js';
export * from './helpers/summary.js';
export * from './helpers/tabs.js';
export * from './helpers/targets.js';
export * from './helpers/translation-errors.js';
export * from './helpers/updates.js';
