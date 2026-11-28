// Source text as the rule checks in test/unit/rules/ read it: without comments, and without the
// contents of strings. A scanner, not a parser: it does not understand regular expression literals
// that contain quotes or `//`, nor template literals with nested `${}` strings.

// Source without comments. Strings are copied whole so that `//` in a URL is not taken for a comment.
export function stripComments(code) {
  let out = '';
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    const n = code[i + 1];
    if (c === '/' && n === '/') {
      while (i < code.length && code[i] !== '\n') i++;
    } else if (c === '/' && n === '*') {
      const end = code.indexOf('*/', i + 2);
      i = end < 0 ? code.length : end + 2;
      out += ' ';
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < code.length && code[j] !== c && !(c !== '`' && code[j] === '\n')) j += code[j] === '\\' ? 2 : 1;
      out += code.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// Blank out string contents too, to look for identifiers in code only.
export const codeOnly = (code) => stripComments(code).replace(/(['"`])(?:\\.|(?!\1)[^\\\n])*\1/g, '""');
