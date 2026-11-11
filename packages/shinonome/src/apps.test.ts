import { describe, expect, it } from "vitest";
import { parseDesktopCheck, parseLaunchableApps } from "./apps";

describe("parseLaunchableApps", () => {
	it("reads the server's lines, sorted by name", () => {
		const output = [
			"app\tcom.android.settings/com.android.settings.Settings\tSettings\tUklGRg==",
			"app\tcom.android.chrome/com.google.android.apps.chrome.Main\tChrome\t",
			"something the runtime printed",
			"",
		].join("\r\n");
		expect(parseLaunchableApps(output)).toEqual([
			{
				component: "com.android.chrome/com.google.android.apps.chrome.Main",
				packageName: "com.android.chrome",
				name: "Chrome",
				icon: null,
			},
			{
				component: "com.android.settings/com.android.settings.Settings",
				packageName: "com.android.settings",
				name: "Settings",
				icon: "data:image/webp;base64,UklGRg==",
			},
		]);
	});

	it("names an app by its package when it has no name, and lists each activity once", () => {
		const line = "app\tcom.example/.Main\t\t";
		expect(parseLaunchableApps(`${line}\n${line}\n`)).toEqual([
			{ component: "com.example/.Main", packageName: "com.example", name: "com.example", icon: null },
		]);
	});
});

describe("parseDesktopCheck", () => {
	it("says null when the phone can make a desktop", () => {
		expect(parseDesktopCheck("desktop: ok\n")).toBeNull();
	});

	it("passes on Android's reason when it can't", () => {
		expect(parseDesktopCheck("desktop: This device does not support desktop windows.\r\n")).toBe(
			"This device does not support desktop windows.",
		);
	});

	it("throws when the server didn't answer", () => {
		expect(() => parseDesktopCheck("Error: no such class\n")).toThrow("no such class");
	});
});
