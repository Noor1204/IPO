#!/usr/bin/env bash
# Builds and signs the Trendy IPO Android app (android/webview) without Android Studio.
# Needs (see docs/ANDROID.md): a JDK (17+), Android build-tools r34 and platform android-34 (android.jar) from dl.google.com, and your signing key.
# Usage: BT=<build-tools dir> PLATFORM_JAR=<android.jar> JDK=<jdk dir> KS=<keystore> KSPASS=<password file> OUT=<output dir> bash scripts/build-android.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${BT:?}" "${PLATFORM_JAR:?}" "${JDK:?}" "${KS:?}" "${KSPASS:?}" "${OUT:?}"
SRC="$ROOT/android/webview"; W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
mkdir -p "$W/res" "$W/gen" "$W/classes" "$W/dex" "$OUT"
cp -r "$SRC/res/." "$W/res/"
for d in mipmap-xxxhdpi mipmap-xxhdpi mipmap-xhdpi mipmap-hdpi mipmap-mdpi; do mkdir -p "$W/res/$d"; cp "$ROOT/icons/icon-512.png" "$W/res/$d/ic_launcher.png"; done
"$BT/aapt2.exe" compile --dir "$W/res" -o "$W/res.zip"
"$BT/aapt2.exe" link -o "$W/base.apk" -I "$PLATFORM_JAR" --manifest "$SRC/AndroidManifest.xml" --java "$W/gen" --min-sdk-version 24 --target-sdk-version 34 "$W/res.zip"
"$JDK/bin/javac" -g --release 8 -cp "$PLATFORM_JAR" -d "$W/classes" $(find "$SRC/src" "$W/gen" -name '*.java')
"$BT/d8.bat" --release --min-api 24 --lib "$PLATFORM_JAR" --output "$W/dex" $(find "$W/classes" -name '*.class')
( cd "$W/dex" && "$BT/aapt.exe" add "$W/base.apk" classes.dex >/dev/null )
"$BT/zipalign.exe" -p -f 4 "$W/base.apk" "$W/aligned.apk"
"$BT/apksigner.bat" sign --ks "$KS" --ks-type PKCS12 --ks-key-alias trendyipo --ks-pass "file:$KSPASS" --out "$OUT/Trendy-IPO-native.apk" "$W/aligned.apk"
"$BT/apksigner.bat" verify --verbose "$OUT/Trendy-IPO-native.apk" 2>&1 | grep -E "Verifies|v2|v3"
echo "built: $OUT/Trendy-IPO-native.apk"
