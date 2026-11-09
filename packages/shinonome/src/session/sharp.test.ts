import { describe, expect, it } from "vitest";
import type { DesktopStatus } from "./protocol";
import { sharpSuggestion } from "./sharp";

const status = (needsSharp?: string | null): DesktopStatus => ({
	displayId: 7,
	width: 1920,
	height: 1054,
	locked: false,
	usable: true,
	desktop: true,
	encoder: "c2.google.avc.encoder",
	dpi: 160,
	dropped: 0,
	needsSharp,
});

describe("sharpSuggestion", () => {
	it("offers sharp mode for the app the server names", () => {
		expect(sharpSuggestion(status("Discord"), false)).toBe("Discord");
	});

	it("offers nothing when no app needs it, or the server is from before this", () => {
		expect(sharpSuggestion(status(null), false)).toBeNull();
		expect(sharpSuggestion(status(undefined), false)).toBeNull();
		expect(sharpSuggestion(null, false)).toBeNull();
	});

	it("stops offering once sharp mode is on, before the server catches up", () => {
		expect(sharpSuggestion(status("Discord"), true)).toBeNull();
	});

	it("doesn't ask again about an app someone said no for", () => {
		expect(sharpSuggestion(status("Discord"), false, new Set(["Discord"]))).toBeNull();
		expect(sharpSuggestion(status("Bluesky"), false, new Set(["Discord"]))).toBe("Bluesky");
	});
});
