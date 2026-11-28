// The languages of an audio file, chosen in the import dialog: what its selects show, and what the
// listening choice and the saved settings hold, to tell that the dialog leaves them alone.

// The dialog's languages as { A, B, C } ('' for no third language).
export const importChoice = (page) =>
  page.evaluate(() => ({
    A: document.getElementById('importLangA').value,
    B: document.getElementById('importLangB').value,
    C: document.getElementById('importLangC').value,
  }));

// The languages chosen for listening: the selects of the bottom bar's popover, the text of its button
// and the saved settings.
export const listeningChoice = (page) =>
  page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('rt-settings') || '{}');
    return {
      selects: ['langA', 'langB', 'langC'].map((id) => document.getElementById(id).value),
      summary: document.getElementById('listenSummary').textContent,
      saved: [saved.langA, saved.langB, saved.langC],
    };
  });
