// Notices: one at a time, as an inline banner above the transcript (`els.toast`), hidden again after a
// while. A new notice replaces the one shown. They never take the focus (the banner is a status region).

// Returns toast(message, ms, variant): shows `message` for `ms` milliseconds; variant: 'info',
// 'warning' or 'critical'.
export function createToast({ els }) {
  let timer;
  return function toast(message, ms = 6000, variant = 'info') {
    els.toast.textContent = message;
    els.toast.dataset.variant = variant;
    els.toast.hidden = false;
    clearTimeout(timer);
    timer = setTimeout(() => {
      els.toast.hidden = true;
    }, ms);
  };
}
