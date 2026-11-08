import { describe, expect, it } from "vitest";
import { keycodeFor } from "./keyboard";

describe("keycodeFor", () => {
	it("goes by the key that was pressed", () => {
		expect(keycodeFor("KeyA", "a")).toBe(29);
		expect(keycodeFor("Period", ">")).toBe(56);
		expect(keycodeFor("Enter", "Enter")).toBe(66);
	});

	it("falls back to the character when there is no key code", () => {
		expect(keycodeFor("", "q")).toBe(45);
		expect(keycodeFor("", "Q")).toBe(45);
		expect(keycodeFor("", "7")).toBe(14);
		expect(keycodeFor("", ".")).toBe(56);
		expect(keycodeFor("", "/")).toBe(76);
		expect(keycodeFor("", " ")).toBe(62);
		expect(keycodeFor("", "Backspace")).toBe(67);
	});

	it("ignores what it has no key for", () => {
		expect(keycodeFor("", "?")).toBeUndefined();
		expect(keycodeFor("", "é")).toBeUndefined();
		expect(keycodeFor("Lang1", "")).toBeUndefined();
	});
});
