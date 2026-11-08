# @wonderhoy-labs/shinonome

The Pixel's desktop in any web page, over `adb`: video, mouse and keyboard, sound, clipboard, dropped files and sharp
mode. It starts Shinonome's server from the APK it carries, at `@wonderhoy-labs/shinonome/shinonome.apk`.

```ts
import { DesktopSession, Phone, runDesktopLink } from "@wonderhoy-labs/shinonome";
import apkUrl from "@wonderhoy-labs/shinonome/shinonome.apk?url";

const phone = new Phone(adb, "My phone");
if (!(await phone.isServerRunning())) {
	await phone.startServer(new Uint8Array(await (await fetch(apkUrl)).arrayBuffer()));
}
const session = new DesktopSession(canvas, {});
await runDesktopLink(await phone.openDesktopSocket(), session);
```

`adb` is a connected `Adb` from [Tango](https://github.com/yume-chan/ya-webadb). The rest is in
[Shinonome's README](https://github.com/wonderhoy-labs/shinonome#use-it-in-your-app). Apache License 2.0.
