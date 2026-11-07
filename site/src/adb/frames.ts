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
