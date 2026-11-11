import { describe, expect, it } from "vitest";
import { fitDesktopSize } from "./fit";

describe("fitDesktopSize", () => {
	it("fills a 16:9 window at the usual size", () => {
		expect(fitDesktopSize(1920, 1080)).toEqual([1920, 1080]);
		expect(fitDesktopSize(1280, 720)).toEqual([1920, 1080]);
	});

	it("stays within the box on a 16:10 screen", () => {
		expect(fitDesktopSize(1800, 1130)).toEqual([1912, 1200]);
		expect(fitDesktopSize(1680, 1050)).toEqual([1920, 1200]);
	});

	it("follows a window with the toolbar taking some height", () => {
		expect(fitDesktopSize(1840, 980)).toEqual([1920, 1022]);
	});

	it("stops at the widest shape the desktop suits", () => {
		expect(fitDesktopSize(5120, 1080)).toEqual([1920, 822]);
	});

	it("doesn't go portrait", () => {
		expect(fitDesktopSize(800, 1000)).toEqual([1200, 1200]);
	});

	it("goes portrait for one app when asked", () => {
		expect(fitDesktopSize(700, 852, true)).toEqual([1200, 1460]);
		expect(fitDesktopSize(400, 1200, true)).toEqual([822, 1920]);
		expect(fitDesktopSize(1920, 1080, true)).toEqual([1920, 1080]);
	});

	it("always gives even numbers, which the encoder needs", () => {
		for (const [width, height] of [
			[1333, 777],
			[1001, 999],
			[1919, 1079],
			[2047, 1151],
		] as const) {
			const [w, h] = fitDesktopSize(width, height);
			expect(w % 2).toBe(0);
			expect(h % 2).toBe(0);
		}
	});

	it("has a sensible answer before the window has a size", () => {
		expect(fitDesktopSize(0, 0)).toEqual([1920, 1080]);
	});
});
