# Android app (APK)

`android/Trendy-IPO-1.1.0.apk` is a small native Android app (package `com.zynora.trendyipo`, versionCode 2, Android 7 or newer) that shows https://noor1204.github.io/IPO/ full screen in a WebView: no browser bar, back button goes back inside the app, links to other sites open in the phone's browser. The website is the app, so every website update appears without a new APK. Source: `android/webview/` (about 100 lines of Java), build script: `scripts/build-android.sh`.

## Install
Send the APK to a phone (WhatsApp / Drive) or download it from the repository page `android/Trendy-IPO-1.1.0.apk` ("Download raw file"), open it and allow "install from this source". Remove the older test app `io.github.noor1204.twa` (the PWABuilder one with the browser bar) if it is installed.

## The signing key is NOT in this repository
The APK is signed with a private key that lives only on the owner's machine, in `D:\Playwright\android-release\` (`trendy-ipo-release.keystore`, alias `trendyipo`, and `keystore-password.txt`). Keep copies of both in two places (for example Google Drive and a pen drive). Without them no update can be installed over this APK. Never commit them: the repository is public.

## Build it again (any Windows computer)
1. Install a JDK 17+ and Git Bash.
2. Download from dl.google.com and unzip: Android `build-tools` r34 (`build-tools_r34-windows.zip`, SHA-1 `62cfde1b6fcc3ad12a4d2ba1b537e752768bfd47`) and platform `android-34` (`platform-34-ext7_r03.zip`, SHA-1 `1f2e9478d6a7601425ceaa553311dc43191f103d`, it contains `android.jar`).
3. First time only, create the key: `keytool -genkeypair -keystore trendy-ipo-release.keystore -storetype PKCS12 -alias trendyipo -keyalg RSA -keysize 2048 -validity 10000 -storepass:file keystore-password.txt -dname "CN=Trendy IPO, O=Zynora Technology, C=IN"`.
4. `BT=<build-tools folder> PLATFORM_JAR=<path to android.jar> JDK=<jdk folder> KS=<keystore> KSPASS=<password file> OUT=<output folder> bash scripts/build-android.sh`
For a new version raise `versionCode` in `android/webview/AndroidManifest.xml` and sign with the SAME keystore.

## Notes
- Google sign-in does not work inside a WebView (Google blocks it), so the optional sign-in (off by default, ADMIN.md) would have to open in the phone's browser; it is not wired for the app.
- CSV download from Reports opens the browser instead of saving inside the app.
- An earlier PWABuilder build (a Trusted Web Activity) showed a Chrome bar because the digital-asset-links file cannot be hosted on a GitHub project page; this native app does not need it.
- Play Store needs an `.aab`, a Google Play developer account and a privacy-policy URL; this build script makes an APK only.
