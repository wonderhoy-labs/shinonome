// Plays the phone's sound: 10 ms packets of 16-bit little-endian stereo PCM at 48 kHz. Each packet is scheduled
// straight after the one before, a little ahead of the clock, so packets that arrive unevenly still play evenly.

export const SAMPLE_RATE = 48_000;
const BYTES_PER_FRAME = 4;
// How far ahead sound starts after a gap. Android hands over sound every 20 ms, two packets at a time, so this covers
// that and a little lateness on the link.
export const START_LEAD_S = 0.03;
// Running dry while sound is flowing means the link is less even than that, so each time the lead grows by a step.
const LEAD_STEP_S = 0.01;
const MAX_START_LEAD_S = 0.1;
// More queued than the lead and this, and packets are dropped until it isn't. A burst after a stall, or a phone whose
// clock runs a little fast, would otherwise leave the sound trailing the picture for the rest of the session.
export const EXTRA_LEAD_S = 0.03;
// Under this, the next packet would start late or overlap, so it counts as having run dry.
const MIN_LEAD_S = 0.002;
// The phone sends nothing while nothing plays, so a gap this long is quiet rather than the link falling behind.
const QUIET_GAP_S = 0.1;

/**
 * When a packet should start, given the time now, when the last one ends and the lead to start with, or null to drop
 * it. Exported for tests.
 */
export function scheduleAt(now: number, queuedUntil: number, startLead = START_LEAD_S): number | null {
	const lead = queuedUntil - now;
	if (lead < MIN_LEAD_S) {
		return now + startLead;
	}
	if (lead > startLead + EXTRA_LEAD_S) {
		return null;
	}
	return queuedUntil;
}

/** Splits interleaved 16-bit little-endian stereo into two channels of floats. Exported for tests. */
export function decodePcm(view: DataView, offset: number, left: Float32Array, right: Float32Array) {
	const frames = Math.min(left.length, Math.floor((view.byteLength - offset) / BYTES_PER_FRAME));
	for (let i = 0, at = offset; i < frames; i++, at += BYTES_PER_FRAME) {
		left[i] = view.getInt16(at, true) / 32768;
		right[i] = view.getInt16(at + 2, true) / 32768;
	}
}

export interface AudioCounts {
	packets: number;
	/** Times sound started after a quiet spell. */
	starts: number;
	/** Times it ran dry while sound was flowing. */
	underruns: number;
	dropped: number;
	leadMs: number;
}

export class AudioPlayer {
	private context: AudioContext | null = null;
	private queuedUntil = 0;
	private lastArrival = Number.NEGATIVE_INFINITY;
	private startLead = START_LEAD_S;
	readonly counts: AudioCounts = { packets: 0, starts: 0, underruns: 0, dropped: 0, leadMs: START_LEAD_S * 1000 };

	get isRunning(): boolean {
		return this.context?.state === "running";
	}

	/**
	 * Opens the sound output. Browsers only allow that after someone has clicked or typed on the page, so this
	 * resolves to false until then, and should be tried again from such an event.
	 */
	async start(): Promise<boolean> {
		if (!this.context) {
			this.context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" });
		}
		if (this.context.state !== "running") {
			// Without someone's click this never settles in some browsers, so don't wait long. Closing the context
			// later rejects the resume that's still waiting, which is nothing to report.
			const resumed = this.context.resume().catch(() => undefined);
			await Promise.race([resumed, new Promise((resolve) => setTimeout(resolve, 200))]);
		}
		return this.isRunning;
	}

	/** Plays the PCM that starts at offset in view. */
	play(view: DataView, offset: number) {
		const context = this.context;
		if (context?.state !== "running") {
			return;
		}
		const frames = Math.floor((view.byteLength - offset) / BYTES_PER_FRAME);
		if (frames <= 0) {
			return;
		}
		this.counts.packets++;
		const now = context.currentTime;
		const quiet = now - this.lastArrival > QUIET_GAP_S;
		this.lastArrival = now;
		const at = scheduleAt(now, this.queuedUntil, this.startLead);
		if (at === null) {
			this.counts.dropped++;
			return;
		}
		if (at !== this.queuedUntil) {
			if (quiet) {
				this.counts.starts++;
			} else {
				this.counts.underruns++;
				this.startLead = Math.min(MAX_START_LEAD_S, this.startLead + LEAD_STEP_S);
				this.counts.leadMs = Math.round(this.startLead * 1000);
			}
		}
		const buffer = context.createBuffer(2, frames, SAMPLE_RATE);
		decodePcm(view, offset, buffer.getChannelData(0), buffer.getChannelData(1));
		const source = context.createBufferSource();
		source.buffer = buffer;
		source.connect(context.destination);
		source.start(at);
		this.queuedUntil = at + buffer.duration;
	}

	/** How far behind the phone the sound plays, in seconds, not counting the phone's own capture. */
	get outputDelay(): number | null {
		const context = this.context;
		if (context?.state !== "running") {
			return null;
		}
		return Math.max(0, this.queuedUntil - context.currentTime) + context.baseLatency + (context.outputLatency || 0);
	}

	async stop() {
		const context = this.context;
		this.context = null;
		this.queuedUntil = 0;
		this.lastArrival = Number.NEGATIVE_INFINITY;
		await context?.close();
	}
}
