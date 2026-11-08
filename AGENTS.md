# AGENTS.md

Read the Wonderhoy Labs unification skill, [.claude/skills/wonderhoy-unification/SKILL.md](.claude/skills/wonderhoy-unification/SKILL.md),
before changing anything. It's the same in every Wonderhoy Labs repository. This file only adds what's particular
to Shinonome.

## What Shinonome is

The Pixel's desktop mode without a monitor. It creates a virtual display that Android treats as one, and shows it on
the phone itself, in a browser over Wi-Fi (the phone serves the page, with TLS and a pairing code), in a browser over
USB (the USB site, through WebUSB), or in scrcpy. The server runs as the shell user, started by Shizuku, the USB site
or `adb`. Named for Shinonome Ena of 25-ji, Nightcord de. Asahi grew out of it. The USB site is at
<https://wonderhoy-labs.github.io/shinonome/>.

## Layout

| Path | What |
| --- | --- |
| `android/app/src/main/java/com/wonderhoylabs/shinonome/server/` | The server and desktop, in Java, run through `app_process` |
| `android/app/src/main/kotlin/com/wonderhoylabs/shinonome/` | The app's Compose screen, the desktop activity and the Shizuku helper |
| `android/app/src/main/assets/web/` | The page the phone serves. `client.js` is generated from `web/src`; never edit it |
| `android/app/src/main/assets/start.sh` | Starts the server as the shell user, from any of the three routes |
| `packages/shinonome/` | The library both web pages use: the session, sound, clipboard, and starting the server over adb |
| `web/src/phone-page/` | The phone's page, built into the assets with `pnpm build:phone-page` |
| `tools/measure.ts` | Drives Chrome against a live session to measure latency and real drags (`pnpm measure`) |

## Build, test and format

```bash
pnpm install && pnpm unify
cd android && ./gradlew spotlessApply :app:assembleDebug :app:lintRelease :app:assembleRelease
cd packages/shinonome && pnpm test
cd web && pnpm test && pnpm build && pnpm build:phone-page
```

The USB site carries the release APK, so build the app first. After changing `packages/shinonome/` or
`web/src/phone-page/`, run `pnpm build:phone-page` and commit `client.js`; CI checks it's current.

## Things to know

- **Only one virtual desktop can run at a time.** Android leaves a second one without title bars, so starting a
  session closes the phone's desktop.
- **`pnpm measure` clicks and drags on a live phone.** It once clicked inside the real Settings app. It targets the
  debug build's test window and closes Settings first. Never point it at real apps, and never run it without a
  session the maintainer started for it.
- **Never test drags with scrcpy's default mouse.** It crashes SystemUI and closes every window on the desktop.
- **WebUSB and adb can't share a phone.** Stop adb (`adb kill-server`) for the USB site, or use `pnpm dev`, which
  reaches devices through the adb server instead.
- **`@wonderhoy-labs/shinonome` is a public library.** Asahi uses its releases. What `src/index.ts` exports is the
  API: keep it documented, and bump the minor version for a breaking change. A change to the messages bumps `PROTOCOL`
  here and `USB_PROTOCOL` in `Server.java` together.
- **The Pixel's encoder ignores any operating rate above 480**, so `Encoder.MAX_OPERATING_RATE` caps it. Measure before
  raising it.
- **React Native apps such as Discord draw clipped text** unless the desktop's density equals the phone's. Sharp mode
  (`RESIZE_SHARP`) gives the desktop the phone's density and costs about 10 ms. Keep it opt-in.
- The debug test window beeps when started with `--ez tone true`, for testing sound without real apps.
- The desktop server's process setup is adapted from scrcpy, under the Apache License 2.0. Keep its notice.
- Never replace the Android signing key. CI signs with the `SHINONOME_KEYSTORE_BASE64`, `SHINONOME_KEYSTORE_PASSWORD`,
  `SHINONOME_KEY_ALIAS` and `SHINONOME_KEY_PASSWORD` secrets.

## Exceptions to the guideline

- `DesktopActivity` is the desktop itself, a full-screen display surface, so it has no Compose frame.
- The phone's page (`android/app/src/main/assets/web/`) is plain HTML, CSS and generated JavaScript, because the
  phone serves it to any browser and the APK is built without Node.
- The live desktop view in the USB site fills the window and leaves out the shared bar and footer.
