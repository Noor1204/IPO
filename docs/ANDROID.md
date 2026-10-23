# Android app (APK)

`android/Trendy-IPO-1.0.0.apk` is the website wrapped as an Android app (a Trusted Web Activity made with PWABuilder, package `io.github.noor1204.twa`, versionCode 1, Android 7 or newer). It opens https://noor1204.github.io/IPO/, so every website update shows up in the app without a new APK.

## Install
Send the APK to a phone, open it and allow "install from this source". Download it from the repository page `android/Trendy-IPO-1.0.0.apk` ("Download raw file").

## The signing key is NOT in this repository
The APK is signed with a private key that lives only on the owner's machine, in `D:\Playwright\android-release\` (`trendy-ipo-release.keystore`, alias `trendyipo`, and `keystore-password.txt`). Keep copies of both in two places (for example Google Drive and a pen drive). Without them no update can be installed over this APK. Never commit them: the repository is public.

## How it was built (to redo it on any computer)
1. https://www.pwabuilder.com , enter the site URL, Package for stores, Android, Other Android, Download Package. The zip holds an *unsigned* `.apk` and `.aab`; an unsigned APK cannot be installed ("package appears to be invalid").
2. Download Android `build-tools` r34 (windows zip) from `https://dl.google.com/android/repository/build-tools_r34-windows.zip` and check its SHA-1 (`62cfde1b6fcc3ad12a4d2ba1b537e752768bfd47`).
3. Create a key once: `keytool -genkeypair -keystore trendy-ipo-release.keystore -storetype PKCS12 -alias trendyipo -keyalg RSA -keysize 2048 -validity 10000 -storepass:file keystore-password.txt -dname "CN=Trendy IPO, O=Zynora Technology, C=IN"` (JDK 17 or newer).
4. `zipalign -p -f 4 unsigned.apk aligned.apk`
5. `apksigner sign --ks trendy-ipo-release.keystore --ks-type PKCS12 --ks-key-alias trendyipo --ks-pass file:keystore-password.txt --out Trendy-IPO.apk aligned.apk`
6. `apksigner verify --verbose Trendy-IPO.apk` must say "Verifies" with v2 and v3 true.
For a new version raise `versionCode` in the PWABuilder form, build again and sign with the SAME keystore.

## Notes
- The site is a GitHub project page (`/IPO/`), so the Android app may show a thin address bar: the digital-asset-links file must be at the domain root, which a project page cannot host. A custom domain or a `Noor1204.github.io` repository would fix that.
- Play Store needs the `.aab`, a Google Play developer account and a privacy-policy URL; the AAB must be signed with an upload key (PWABuilder's "Google Play" tab can create one).
