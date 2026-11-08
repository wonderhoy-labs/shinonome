import { describe, expect, it } from "vitest";
import { batchedWriter, FrameReader, frameMessage } from "./frames";

function collect(reader: FrameReader, chunks: Uint8Array[]): number[][] {
	const messages: number[][] = [];
	for (const chunk of chunks) {
		reader.push(chunk, (message) => messages.push(Array.from(new Uint8Array(message))));
	}
	return messages;
}

describe("FrameReader", () => {
	const first = frameMessage(new Uint8Array([5, 1]));
	const second = frameMessage(new Uint8Array([2, 9, 9, 9]));
	const both = new Uint8Array([...first, ...second]);

	it("reads two messages from one chunk", () => {
		expect(collect(new FrameReader(), [both])).toEqual([
			[5, 1],
			[2, 9, 9, 9],
		]);
	});

	it("reads messages however they were split", () => {
		for (let cut = 1; cut < both.length; cut++) {
			expect(collect(new FrameReader(), [both.slice(0, cut), both.slice(cut)])).toEqual([
				[5, 1],
				[2, 9, 9, 9],
			]);
		}
	});

	it("reads one byte at a time", () => {
		expect(
			collect(
				new FrameReader(),
				Array.from(both, (byte) => new Uint8Array([byte])),
			),
		).toEqual([
			[5, 1],
			[2, 9, 9, 9],
		]);
	});

	it("gives each message its own memory", () => {
		const reader = new FrameReader();
		const kept: ArrayBuffer[] = [];
		reader.push(first, (message) => kept.push(message));
		reader.push(second, (message) => kept.push(message));
		expect(Array.from(new Uint8Array(kept[0] as ArrayBuffer))).toEqual([5, 1]);
	});

	it("copes with a message bigger than its starting buffer", () => {
		const big = new Uint8Array(3 * 1024 * 1024).fill(7);
		const reader = new FrameReader();
		let length = 0;
		reader.push(frameMessage(big), (message) => {
			length = message.byteLength;
		});
		expect(length).toBe(big.length);
	});
});

describe("frameMessage", () => {
	it("puts a big-endian length in front", () => {
		expect(Array.from(frameMessage(new Uint8Array([22])))).toEqual([0, 0, 0, 1, 22]);
	});

	it("takes an ArrayBuffer as well", () => {
		expect(Array.from(frameMessage(new Uint8Array([16, 1, 2]).buffer))).toEqual([0, 0, 0, 3, 16, 1, 2]);
	});
});

describe("batchedWriter", () => {
	it("sends everything from one task as one write", async () => {
		const writes: number[][] = [];
		const send = batchedWriter((bytes) => writes.push(Array.from(bytes)));
		send(new Uint8Array([16, 1]));
		send(new Uint8Array([22]).buffer);
		expect(writes).toEqual([]);
		await Promise.resolve();
		expect(writes).toEqual([[0, 0, 0, 2, 16, 1, 0, 0, 0, 1, 22]]);
	});

	it("sends a lone message as it is", async () => {
		const writes: Uint8Array[] = [];
		const send = batchedWriter((bytes) => writes.push(bytes));
		send(new Uint8Array([19]));
		await Promise.resolve();
		expect(writes.map((bytes) => Array.from(bytes))).toEqual([[0, 0, 0, 1, 19]]);
	});

	it("starts a new write for messages sent after the last one went", async () => {
		const writes: number[][] = [];
		const send = batchedWriter((bytes) => writes.push(Array.from(bytes)));
		send(new Uint8Array([1]));
		await Promise.resolve();
		send(new Uint8Array([2]));
		await Promise.resolve();
		expect(writes).toEqual([
			[0, 0, 0, 1, 1],
			[0, 0, 0, 1, 2],
		]);
	});
});
