// Checks that a built macOS app has a valid signature whose identity does not change between
// builds. Used by the release workflow; fails (exit 1) otherwise.
//
//   node scripts/verify-mac-signature.js <path to .app> <bundle identifier> [--allow-adhoc]
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// `codesign -dr -` prints the designated requirement. An ad hoc signature pins the code hash
// ("cdhash H\"…\""), which is different for every build; a certificate-based one names the
// identifier and the certificate.
export function checkRequirement(output, identifier) {
  const line = output.split('\n').find((l) => l.includes('designated =>'));
  if (!line) return { ok: false, reason: 'no designated requirement found' };
  const requirement = line.slice(line.indexOf('designated =>') + 'designated =>'.length).trim();
  if (/\bcdhash\b/.test(requirement))
    return { ok: false, requirement, reason: 'ad hoc signature: the identity changes with every build' };
  // Parsed with a fixed pattern and compared as a plain string, so the identifier passed on the
  // command line never becomes part of a regular expression.
  const match = /^identifier "([^"]+)" and certificate leaf = H"[0-9a-f]{40}"$/.exec(requirement);
  if (!match || match[1] !== identifier) {
    return { ok: false, requirement, reason: 'not the expected identifier and certificate form' };
  }
  return { ok: true, requirement };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [app, identifier, flag] = process.argv.slice(2);
  if (!app || !identifier) {
    console.error('usage: node scripts/verify-mac-signature.js <app> <identifier> [--allow-adhoc]');
    process.exit(2);
  }
  const run = (...args) => execFileSync('codesign', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  } catch {
    console.error('codesign --verify --deep --strict failed');
    process.exit(1);
  }
  // codesign writes the requirement to stdout and the rest to stderr.
  const output = run('-d', '-r', '-', app);
  const result = checkRequirement(output, identifier);
  console.log(`designated requirement: ${result.requirement ?? '(none)'}`);
  if (!result.ok && !(flag === '--allow-adhoc' && /ad hoc/.test(result.reason))) {
    console.error(`signature check failed: ${result.reason}`);
    process.exit(1);
  }
  if (!result.ok) console.log('ad hoc signature (no certificate available): allowed for this build');
}
