// Used by tools/measure.mjs, not by normal use.

const PROBE_WIDTH = 240;
const PROBE_HEIGHT = 135;
const PROBE_CHANGE_LEVEL = 10;
const PROBE_CHANGED_CELLS = 3;

export interface FrameTimes {
  encodedUs: number;
  sentUs: number;
  receivedUs: number;
}

const LATENCY_STAGES = ['captureToEncoded', 'encodedToSent', 'sentToReceived', 'receivedToDecoded', 'total'] as const;
type LatencyStage = (typeof LATENCY_STAGES)[number];

export function percentiles(values: number[]) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => Math.round((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] as number) / 100) / 10;
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1), count: sorted.length };
}

export class Measurement {
  active = false;
  bytes = 0;
  frames = 0;
  distinct = 0;
  latencies = {} as Record<LatencyStage, number[]>;
  private probeContext: OffscreenCanvasRenderingContext2D | null = null;
  private previous: Uint8ClampedArray | null = null;
  private waiter: ((time: number) => void) | null = null;

  start() {
    this.active = true;
    this.bytes = 0;
    this.frames = 0;
    this.distinct = 0;
    for (const stage of LATENCY_STAGES) {
      this.latencies[stage] = [];
    }
    this.probeContext ??= new OffscreenCanvas(PROBE_WIDTH, PROBE_HEIGHT).getContext('2d', { willReadFrequently: true });
  }

  record(captureUs: number, times: FrameTimes, decodedUs: number, total: number, clockOffsetUs: number) {
    const sentLocalUs = times.sentUs - clockOffsetUs;
    this.latencies.captureToEncoded.push(times.encodedUs - captureUs);
    this.latencies.encodedToSent.push(times.sentUs - times.encodedUs);
    this.latencies.sentToReceived.push(times.receivedUs - sentLocalUs);
    this.latencies.receivedToDecoded.push(decodedUs - times.receivedUs);
    this.latencies.total.push(total);
  }

  probe(frame: VideoFrame, decodedUs: number) {
    this.frames++;
    const context = this.probeContext;
    if (!context) {
      return;
    }
    context.drawImage(frame, 0, 0, PROBE_WIDTH, PROBE_HEIGHT);
    const pixels = context.getImageData(0, 0, PROBE_WIDTH, PROBE_HEIGHT).data;
    let changed = 0;
    if (this.previous) {
      for (let i = 1; i < pixels.length; i += 4) {
        if (Math.abs((pixels[i] as number) - (this.previous[i] as number)) > PROBE_CHANGE_LEVEL) {
          changed++;
        }
      }
    }
    this.previous = pixels;
    if (changed >= PROBE_CHANGED_CELLS) {
      this.distinct++;
      if (this.waiter) {
        const resolve = this.waiter;
        this.waiter = null;
        resolve(decodedUs);
      }
    }
  }

  waitForChange(timeoutMs: number): Promise<number | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        resolve(null);
      }, timeoutMs);
      this.waiter = (time) => {
        clearTimeout(timer);
        resolve(time);
      };
    });
  }

  summary() {
    return Object.fromEntries(LATENCY_STAGES.map((stage) => [stage, percentiles(this.latencies[stage])]));
  }
}
