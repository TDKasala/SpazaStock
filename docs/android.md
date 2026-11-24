# SpazaStock for Android

`android/` is a Trusted Web Activity (TWA): a small Android app, package
`za.co.kasalatechnologies.spazastock`, that opens https://spazastock.swipe-a-bill.com full screen
in Chrome. Every website deploy updates the app; only icon, name or colour changes need a new
Play upload. Web Push alerts show as SpazaStock app notifications.

## Builds

`.github/workflows/android.yml` runs on every push that touches `android/` (or by hand from the
Actions tab):

- `spazastock-debug-apk`: install on a phone to test (allow "install unknown apps").
- `spazastock-release-aab`: the signed bundle for Google Play, only once the secrets below exist.

The version code is the workflow run number, so each build can be uploaded.

## One-time setup

1. **Upload key** (on your own computer, keep the file and passwords safe and private):
   ```sh
   keytool -genkeypair -v -keystore spazastock-upload.jks -alias upload \
     -keyalg RSA -keysize 2048 -validity 10000
   base64 -w0 spazastock-upload.jks   # macOS: base64 -i spazastock-upload.jks
   ```
2. **GitHub secrets** (repo Settings > Secrets and variables > Actions):
   `ANDROID_KEYSTORE_BASE64` (the base64 output), `ANDROID_KEYSTORE_PASSWORD`,
   `ANDROID_KEY_ALIAS` (`upload`), `ANDROID_KEY_PASSWORD`. Re-run the Android workflow.
3. **Google Play Console**: create the app, upload `app-release.aab` to Internal testing, and accept
   Play App Signing.
4. **Verify the site**: Play Console > Test and release > App integrity > App signing, copy the
   *App signing key* SHA-256 fingerprint into `public/.well-known/assetlinks.json` (replacing
   `REPLACE_WITH_PLAY_APP_SIGNING_SHA256`; add the upload key's fingerprint too if you sideload
   release builds) and deploy. Check it at
   https://spazastock.swipe-a-bill.com/.well-known/assetlinks.json.
   Until it matches, the app works but shows a thin address bar at the top.

## Changing things

- Site address: `siteHost` in `android/app/build.gradle.kts` (and `assetlinks.json` on that host).
- Colours: `android/app/src/main/res/values/colors.xml`.
- Icons: generated from `public/icon.svg` into `android/app/src/main/res/mipmap-*` and `drawable-*`.
