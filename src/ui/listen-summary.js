// What the button of the bottom bar says is listened to: the selected languages and the audio input,
// in one line, for example "Japanese ⇄ English · Microphone". The choices themselves are in the
// popover it opens (src/ui/listen-choices.js); this only words them.

// languages: the names of the selected languages, in order (two or three; '' or a missing one is
// left out); input: the name of the audio input; t: i18n. Two languages are shown as a pair that is
// translated both ways, three as a list.
export function listenSummary({ languages, input }, t) {
  const [a = '', b = '', c = ''] = languages.filter(Boolean);
  if (c) return t('listen.summary.three', { a, b, c, input });
  if (b) return t('listen.summary.two', { a, b, input });
  return t('listen.summary.one', { a, input });
}
