// electron-builder `afterSign` hook: re-signs the macOS app with a fixed certificate.
//
// electron-builder signs ad hoc (see `mac.identity` in package.json), which gives every build a
// different identity. macOS ties permissions (Screen & System Audio Recording, Microphone) and
// keychain items to that identity, so they were lost with each update. Signing every release with
// the same certificate keeps the identity stable. The certificate is self-signed: the app is not
// notarized and still shows the first-open warning.
//
// MAC_SIGN_IDENTITY is the certificate's SHA-1 hash. Its keychain must be in the user's keychain
// search list: codesign does not find a self-signed (untrusted) identity through `--keychain`
// alone. Without MAC_SIGN_IDENTITY (local builds, pull requests from forks) nothing is done and
// the ad hoc signature stays. The zip is made after this hook, from the re-signed app.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// The codesign calls, innermost first. `--deep` covers the frameworks and helper apps inside the
// bundle, but not a bare executable in Resources, which is sealed as a resource of the app and so
// has to be signed before the app itself.
export function signingPlan({ appPath, identity, helperIdentifier }) {
  const base = ['--force', '--timestamp=none', '--sign', identity];
  return [
    [...base, '--identifier', helperIdentifier, join(appPath, 'Contents', 'Resources', 'system-audio')],
    [...base, '--deep', appPath],
  ];
}

export default async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const identity = process.env.MAC_SIGN_IDENTITY;
  if (!identity) {
    console.log('  • MAC_SIGN_IDENTITY is not set: keeping the ad hoc signature');
    return;
  }
  const { id: appId, productFilename } = context.packager.appInfo;
  const appPath = join(context.appOutDir, `${productFilename}.app`);
  const plan = signingPlan({
    appPath,
    identity,
    helperIdentifier: `${appId}.system-audio`,
  });
  for (const args of plan) execFileSync('codesign', args, { stdio: 'inherit' });
  console.log(`  • re-signed with the fixed certificate  file=${appPath}`);
}
