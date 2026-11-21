// English UI strings. This is the fallback for keys missing in other locales.
// Every key here must exist in every other locale file, with the same {placeholders}.
export default {
  'language.name': 'English',

  // sidebar and session list
  'sidebar.label': 'Sessions',
  'sidebar.newSession': 'New session',
  'session.when': '{date} ・ {duration}',
  'session.rename': 'Rename',
  'session.delete': 'Delete',
  'session.renamePrompt': 'Session name',
  'session.deleteConfirm': 'Delete "{title}"? Its transcript and recordings will be removed.',

  // top bar
  'header.menu': 'Sessions',
  'header.langA': 'Language 1',
  'header.langB': 'Language 2',
  'header.swap.title': 'Swap',
  'header.swap.label': 'Swap languages',
  'header.source': 'Audio input',
  'header.pip.title': 'Show captions in a separate window (always on top)',
  'header.pip.label': 'Show captions in a separate window',
  'header.export': 'Download',
  'header.settings': 'Settings',
  'source.mic': 'Microphone',
  'source.system': 'PC audio',
  'source.both': 'Microphone + PC audio',

  // transcript and caption zone
  'empty.main': 'Choose two languages and press "Start translating".',
  'empty.sub': 'Speak in either language. It is detected automatically and translated into the other one.',
  'log.jump': 'Latest',
  'now.label': 'Sentence being spoken',
  'now.head': 'Now',
  'now.empty': 'Captions appear here once translation starts',
  'caption.title': 'Captions',
  'caption.close': 'Close the caption window',

  // status bar
  'status.idle': 'Stopped',
  'status.connecting': 'Connecting…',
  'status.listening': 'Listening',
  'status.reconnecting': 'Reconnecting…',
  'toggle.start': 'Start translating',
  'toggle.stop': 'Stop',

  // download dialog
  'export.title': 'Download',
  'export.format': 'Transcript format',
  'export.format.txt': 'Text (.txt)',
  'export.format.md': 'Markdown table (.md)',
  'export.format.csv': 'CSV / Excel (.csv)',
  'export.format.srt': 'Subtitles (.srt)',
  'export.content': 'Content',
  'export.content.both': 'Source and translation',
  'export.content.src': 'Source only',
  'export.content.tgt': 'Translation only',
  'export.saveTranscript': 'Save transcript',
  'export.close': 'Close',
  'export.recordings': 'Recordings',
  'export.recording': 'Recording {n} ・ {date} ・ {length}',
  'export.recordingNow': 'Recording',
  'export.save': 'Save',

  // downloaded transcript files
  'file.title': 'Transcript',
  'file.date': 'Date',
  'file.languages': 'Languages',
  'file.duration': 'Duration',
  'file.time': 'Time',
  'file.source': 'Source',
  'file.translation': 'Translation',
  'file.separator': '   ',

  // settings dialog
  'settings.title': 'Settings',
  'settings.apiKey': 'Gemini API key',
  'settings.apiKey.helpBefore': 'Get one for free at ',
  'settings.apiKey.helpAfter': '. The key is stored only on this device.',
  'settings.running':
    'Translation is running. Changes to the API key, translation model, cleanup, recording, glossary and target language take effect the next time you start.',
  'settings.model': 'Translation model',
  'settings.interim': 'Translate sentences while they are being spoken (favors real-time)',
  'settings.smart': 'Clean up the transcript (removes fillers; sentences may take a little longer to finalize)',
  'settings.record': 'Record and save the audio (on this device; about 15 MB per hour)',
  'settings.otherInto': 'When a language other than these two is spoken, translate into',
  'settings.otherInto.left': '{lang} (left language)',
  'settings.otherInto.right': '{lang} (right language)',
  'settings.captionItems': 'Sentences kept in the area below',
  'settings.captionItems.help':
    'This includes the sentence being spoken. More is easier to re-read, and the area gets taller.',
  'settings.captionItems.one': '{n} sentence',
  'settings.captionItems.other': '{n} sentences',
  'settings.interimInterval': 'Interval for re-translating a sentence in progress',
  'settings.interimInterval.help':
    'Shorter shows translations sooner, but the text changes more often and uses more of the API.',
  'settings.interimInterval.value': '{s} s',
  'settings.glossary': 'Glossary and meeting background (used in translation)',
  'settings.glossary.placeholder': 'e.g. proper nouns, product names, meeting topic',
  'settings.fontSize': 'Text size',
  'settings.uiLang': 'Display language',
  'settings.uiLang.auto': 'Auto',
  'settings.save': 'Save',

  // notifications
  'toast.saveFailed': 'Could not save: {message}',
  'toast.deleteFailed': 'Could not delete: {message}',
  'toast.stopToSwitch': 'Stop translating before switching sessions',
  'toast.stopToDelete': 'Stop translating before deleting this session',
  'toast.captionWindowFailed': 'Could not open the caption window: {message}',
  'toast.nothingToSave': 'There is nothing to save',
  'toast.recordingMissing': 'The data for this recording could not be found',
  'toast.noTranscript': 'There is no transcript yet',
  'toast.apiKeyFirst': 'Set your Gemini API key first',
  'toast.audioEnded': 'Audio input ended',
  'toast.permissionNeeded': 'Microphone or screen sharing permission is required. Check your browser settings.',
  'toast.systemAudioSilentMac':
    'No PC audio is coming in. If nothing reacts while sound is playing, allow Twinscript in System Settings → Privacy & Security → "Screen & System Audio Recording" and reopen the app.',
  'toast.systemAudioSilent':
    'No PC audio is coming in. If nothing reacts while sound is playing, check that audio sharing was turned on when you shared.',
  'toast.recordSaveFailed': 'Could not save the recording (check the free storage space)',
  'toast.recordUnsupported': 'This browser cannot record audio, so only the transcript is kept',
  'toast.rateLimited':
    'Rate limit reached. Translation of sentences in progress is paused for 1 minute (finished sentences are still translated).',
  'toast.storageUnavailable': 'Browser storage is unavailable, so the content is lost when this tab is closed',
  'toast.demo': 'Demo mode: no real speech recognition or translation',

  // errors reported by audio.js, transcriber.js and translator.js
  'error.windowBlocked': 'The window was blocked',
  'error.noSharedAudio': 'The shared screen or tab has no audio. Turn on "Share audio" in the sharing dialog.',
  'error.systemAudioPermission':
    'Twinscript has no permission to capture PC audio. Allow it in System Settings → Privacy & Security → "Screen & System Audio Recording" and reopen the app.',
  'error.systemAudioFailed': 'Could not capture PC audio.',
  'error.connectFailed': 'Could not connect: {reason}',
  'error.disconnected': 'Disconnected: {reason}',
  'error.disconnectedCode': 'Disconnected (code {code})',
  'error.rateLimit': 'The translation API rate limit was reached',
  'error.translate': 'Translation error ({status}): {message}',
};
