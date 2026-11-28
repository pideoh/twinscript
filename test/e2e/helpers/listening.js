// The choices of what is listened to (the languages, their swap and the audio input) live in a
// popover of the bottom bar. These open it, make the choice the way a user does, and close it again,
// so that it covers nothing the test does next.

const open = async (page) => {
  if (await page.isHidden('#listenPopover')) await page.click('#listenChoices');
};
const close = async (page) => {
  if (await page.isVisible('#listenPopover')) await page.click('#listenChoices');
};

// Chooses `value` in the select `selector` (#langA, #langB, #langC or #source).
export async function chooseListening(page, selector, value) {
  await open(page);
  await page.selectOption(selector, value);
  await close(page);
}

// Swaps the first two languages with the swap button.
export async function swapLanguages(page) {
  await open(page);
  await page.click('#swap');
  await close(page);
}
