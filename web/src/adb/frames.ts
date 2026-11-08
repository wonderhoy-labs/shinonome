const LENGTH_BYTES = 4;
const INITIAL_BUFFER_BYTES = 1024 * 1024;

/** Every message on the USB link has its length in front, and arrives split across adb packets in any way. */
export class FrameReader {
	private buffer = new Uint8Array(INITIAL_BUFFER_BYTES);
	private filled = 0;

	push(chunk: Uint8Array, onMessage: (message: ArrayBuffer) => void) {
		if (this.filled + chunk.length > this.buffer.length) {
			const bigger = new Uint8Array((this.filled + chunk.length) * 2);
			bigger.set(this.buffer.subarray(0, this.filled));
			this.buffer = bigger;
		}
		this.buffer.set(chunk, this.filled);
		this.filled += chunk.length;

		const view = new DataView(this.buffer.buffer);
		let offset = 0;
		while (this.filled - offset >= LENGTH_BYTES) {
			const length = view.getUint32(offset);
			const start = offset + LENGTH_BYTES;
			if (this.filled - start < length) {
				break;
			}
			onMessage(this.buffer.slice(start, start + length).buffer);
			offset = start + length;
		}
		this.buffer.copyWithin(0, offset, this.filled);
		this.filled -= offset;
	}
}

export function frameMessage(data: ArrayBuffer | Uint8Array): Uint8Array<ArrayBuffer> {
	const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
	const framed = new Uint8Array(LENGTH_BYTES + bytes.length);
	new DataView(framed.buffer).setUint32(0, bytes.length);
	framed.set(bytes, LENGTH_BYTES);
	return framed;
}

/**
 * Sends messages length first, gathering everything sent in one task into a single write. A burst of input, such as a
 * button press after a move, then crosses USB as one transfer instead of several, each of which costs a round trip
 * through the browser.
 */
export function batchedWriter(
	write: (bytes: Uint8Array<ArrayBuffer>) => void,
): (data: ArrayBuffer | Uint8Array) => void {
	let pending: Uint8Array<ArrayBuffer>[] = [];
	const flush = () => {
		const parts = pending;
		pending = [];
		if (parts.length === 1) {
			write(parts[0] as Uint8Array<ArrayBuffer>);
			return;
		}
		const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
		let at = 0;
		for (const part of parts) {
			joined.set(part, at);
			at += part.length;
		}
		write(joined);
	};
	return (data) => {
		pending.push(frameMessage(data));
		if (pending.length === 1) queueMicrotask(flush);
	};
}
