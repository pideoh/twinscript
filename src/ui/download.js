// Saves a file the page made (a transcript, a summary, a trace) through a temporary link. The address
// of the file is released a little later, once the download has had time to start.

export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
