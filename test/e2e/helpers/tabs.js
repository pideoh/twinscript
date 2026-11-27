// The tabs of the main area: which one is shown, and showing one by a click.

// The name (`data-view`) of the tab shown now.
export const shownTab = (page) => page.getAttribute('[role="tab"][aria-selected="true"]', 'data-view');

// Clicks the tab `name` ('transcript', 'summary', 'questions') and waits for its panel.
export async function showTab(page, name) {
  await page.click(`[role="tab"][data-view="${name}"]`);
  await page.waitForSelector(`[role="tabpanel"][data-view="${name}"]:not([hidden])`);
}
