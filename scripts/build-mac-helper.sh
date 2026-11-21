#!/bin/sh
# Builds the macOS system-audio helper (native/mac/system-audio.swift) as a universal binary
# (arm64 + x86_64) at native/mac/build/system-audio. Skips the build when it is up to date.
set -eu
cd "$(dirname "$0")/.."

SRC=native/mac/system-audio.swift
OUT_DIR=native/mac/build
OUT=$OUT_DIR/system-audio

if [ -x "$OUT" ] && [ "$OUT" -nt "$SRC" ] && [ "$OUT" -nt "$0" ]; then
  exit 0
fi

mkdir -p "$OUT_DIR"
for arch in arm64 x86_64; do
  # Deployment target below 13 so the helper starts on older systems and reports
  # "macOS 13 or later is required" with its own exit code instead of failing to load.
  xcrun swiftc -O -swift-version 5 -target "$arch-apple-macos12.3" -o "$OUT_DIR/system-audio-$arch" "$SRC"
done
lipo -create -output "$OUT" "$OUT_DIR/system-audio-arm64" "$OUT_DIR/system-audio-x86_64"
rm -f "$OUT_DIR/system-audio-arm64" "$OUT_DIR/system-audio-x86_64"
codesign --force --sign - --identifier io.github.pideoh.realtime-translate.system-audio "$OUT"
echo "built $OUT"
