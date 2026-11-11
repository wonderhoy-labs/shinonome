import { describe, expect, it } from "vitest";
import { modeArgs, parseMode, sameMode } from "./mode";

describe("modes", () => {
	it("turns a mode into server options", () => {
		expect(modeArgs({ kind: "desktop" })).toEqual([]);
		expect(modeArgs({ kind: "mirror" })).toEqual(["--mirror"]);
		expect(modeArgs({ kind: "app", app: "airi://app/foot.desktop" })).toEqual(["--app", "airi://app/foot.desktop"]);
	});

	it("reads the mode from a server's log", () => {
		expect(parseMode("usb protocol: 2\nmode: mirror\ndisplay 4 created\nlistening\n")).toEqual({ kind: "mirror" });
		expect(parseMode("mode: app airi://app/org.gnome.Calculator.desktop\n")).toEqual({
			kind: "app",
			app: "airi://app/org.gnome.Calculator.desktop",
		});
		expect(parseMode("mode: desktop\n")).toEqual({ kind: "desktop" });
		expect(parseMode("usb protocol: 2\nlistening\n")).toBeNull();
	});

	it("compares modes", () => {
		expect(sameMode({ kind: "mirror" }, { kind: "mirror" })).toBe(true);
		expect(sameMode({ kind: "desktop" }, { kind: "mirror" })).toBe(false);
		expect(sameMode({ kind: "app", app: "a" }, { kind: "app", app: "a" })).toBe(true);
		expect(sameMode({ kind: "app", app: "a" }, { kind: "app", app: "b" })).toBe(false);
	});
});
