import { describe, expect, it } from "vitest";
import { decodePcm, EXTRA_LEAD_S, START_LEAD_S, scheduleAt } from "./audio";

describe("scheduleAt", () => {
	it("starts a little ahead after a gap", () => {
		expect(scheduleAt(10, 0)).toBe(10 + START_LEAD_S);
		expect(scheduleAt(10, 9.5)).toBe(10 + START_LEAD_S);
	});

	it("plays straight after the packet before", () => {
		expect(scheduleAt(10, 10.02)).toBe(10.02);
	});

	it("drops a packet once too much is queued", () => {
		expect(scheduleAt(10, 10 + START_LEAD_S + EXTRA_LEAD_S + 0.001)).toBeNull();
	});

	it("starts further ahead, and allows more queued, with a longer lead", () => {
		expect(scheduleAt(10, 0, 0.05)).toBe(10.05);
		expect(scheduleAt(10, 10.07, 0.05)).toBe(10.07);
	});

	it("keeps playing packets that arrive two at a time every 20 ms", () => {
		let queuedUntil = 0;
		let now = 10;
		for (let pair = 0; pair < 100; pair++, now += 0.02) {
			for (let i = 0; i < 2; i++) {
				const at = scheduleAt(now, queuedUntil);
				expect(at).not.toBeNull();
				if (pair > 0) expect(at).toBeCloseTo(queuedUntil);
				queuedUntil = (at as number) + 0.01;
			}
		}
	});

	it("comes back down to the limit after a burst", () => {
		let queuedUntil = 0;
		let dropped = 0;
		// A stalled link hands over 200 ms of packets at once.
		for (let i = 0; i < 20; i++) {
			const at = scheduleAt(10, queuedUntil);
			if (at === null) {
				dropped++;
			} else {
				queuedUntil = at + 0.01;
			}
		}
		expect(queuedUntil - 10).toBeLessThanOrEqual(START_LEAD_S + EXTRA_LEAD_S + 0.01);
		expect(dropped).toBeGreaterThan(10);
	});
});

describe("decodePcm", () => {
	it("splits little-endian stereo into channels", () => {
		// One byte of something else, then left 0 and right -32768, then left 16384 and right 32767.
		const bytes = new Uint8Array([0xff, 0x00, 0x00, 0x00, 0x80, 0x00, 0x40, 0xff, 0x7f]);
		const left = new Float32Array(2);
		const right = new Float32Array(2);
		decodePcm(new DataView(bytes.buffer), 1, left, right);
		expect(Array.from(left)).toEqual([0, 0.5]);
		expect(right[0]).toBe(-1);
		expect(right[1]).toBeCloseTo(32767 / 32768);
	});

	it("reads from an odd offset, where the video-style header leaves it", () => {
		const bytes = new Uint8Array(9 + 4);
		new DataView(bytes.buffer).setInt16(9, -16384, true);
		const left = new Float32Array(1);
		const right = new Float32Array(1);
		decodePcm(new DataView(bytes.buffer), 9, left, right);
		expect(left[0]).toBe(-0.5);
	});
});
