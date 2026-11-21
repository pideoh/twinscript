#!/bin/sh
# CI only. Puts the macOS signing certificate into a temporary keychain and exports
# MAC_SIGN_IDENTITY (its SHA-1 hash) for scripts/sign-mac.js.
#
#   ci-mac-signing-keychain.sh setup [--throwaway]   needs MAC_CERT_P12_BASE64 and MAC_CERT_PASSWORD
#   ci-mac-signing-keychain.sh cleanup
#
# With --throwaway and no certificate in the environment (pull requests from forks), a
# certificate is generated on the spot so that the signing path can still be exercised.
# Without --throwaway a missing certificate is an error.
set -eu

KEYCHAIN="${RUNNER_TEMP:?}/twinscript-signing.keychain-db"
WORK="$RUNNER_TEMP/twinscript-signing"

if [ "${1:-}" = "cleanup" ]; then
  security delete-keychain "$KEYCHAIN" 2>/dev/null || true
  rm -rf "$WORK"
  exit 0
fi

mkdir -p "$WORK"
if [ -n "${MAC_CERT_P12_BASE64:-}" ]; then
  printf '%s' "$MAC_CERT_P12_BASE64" | base64 --decode > "$WORK/cert.p12"
  P12_PASSWORD="${MAC_CERT_PASSWORD:?MAC_CERT_PASSWORD is not set}"
  echo "Using the certificate from the repository secrets."
elif [ "${2:-}" = "--throwaway" ]; then
  P12_PASSWORD="$(openssl rand -hex 16)"
  /usr/bin/openssl req -x509 -newkey rsa:2048 -sha256 -days 2 -nodes \
    -keyout "$WORK/key.pem" -out "$WORK/cert.pem" -subj "/CN=Twinscript throwaway signing" \
    -addext "keyUsage=critical,digitalSignature" -addext "extendedKeyUsage=critical,codeSigning" \
    -addext "basicConstraints=critical,CA:false" 2>/dev/null
  /usr/bin/openssl pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" \
    -name "Twinscript throwaway signing" -out "$WORK/cert.p12" -passout "pass:$P12_PASSWORD"
  echo "No certificate in the environment: using a throwaway one for this run."
else
  echo "MAC_CERT_P12_BASE64 is not set. Add the signing certificate to the repository secrets (see README)." >&2
  exit 1
fi

KEYCHAIN_PASSWORD="$(openssl rand -hex 24)"
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security set-keychain-settings -lut 3600 "$KEYCHAIN"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security import "$WORK/cert.p12" -k "$KEYCHAIN" -P "$P12_PASSWORD" -T /usr/bin/codesign > /dev/null
security set-key-partition-list -S apple-tool:,apple: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN" > /dev/null
rm -rf "$WORK"

# codesign only finds a self-signed identity in a keychain that is on the search list.
# shellcheck disable=SC2046
security list-keychains -d user -s "$KEYCHAIN" $(security list-keychains -d user | tr -d '"')

IDENTITY="$(security find-identity -p codesigning "$KEYCHAIN" | awk '/[0-9A-F]{40}/ { print $2; exit }')"
[ -n "$IDENTITY" ] || { echo "No code signing identity found in the certificate." >&2; exit 1; }
echo "MAC_SIGN_IDENTITY=$IDENTITY" >> "${GITHUB_ENV:?}"
echo "Signing identity ready (certificate SHA-1 $IDENTITY)."
