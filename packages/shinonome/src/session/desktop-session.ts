// Shows the desktop on a canvas and sends input back. The same code runs on the page the phone serves over
// Wi-Fi and on the USB site. All it needs is a way to send messages and to be handed the ones that arrive.
import { AudioPlayer } from "./audio";
import { fitDesktopSize } from "./fit";
import { isPasteShortcut, keycodeFor, META_CTRL, metaState } from "./keyboard";
import { type FrameTimes, Measurement, percentiles } from "./measure";
import {
	AUDIO_HEADER_BYTES,
	AUTH_LOCKED_OUT,
	AUTH_OK,
	CLIPBOARD_PASTE,
	type DesktopStatus,
	FLAG_CONFIG,
	FLAG_KEY,
	KEY_DOWN,
	KEY_UP,
	MAX_CLIPBOARD_BYTES,
	MessageType,
	MOUSE_MOVE,
	MOUSE_PRESS,
	MOUSE_RELEASE,
	RESIZE_SHARP,
	VIDEO_HEADER_BYTES,
} from "./protocol";

const PING_INTERVAL_MS = 2000;
const CLOCK_SAMPLES = 8;
const MAX_DECODE_QUEUE = 6;
const MAX_TRACKED_FRAMES = 240;
const STATS_INTERVAL_MS = 1000;
// Resizing restarts the encoder, so it waits for the window to settle.
const FIT_DELAY_MS = 400;
// Android takes input once a frame, so pointer moves are sent at most this often. A mouse polling at 1000 Hz would
// otherwise queue a USB transfer a millisecond, and everything sent after waits behind them.
const MOVE_INTERVAL_MS = 4;
// The paste event follows its shortcut straight away. If it doesn't come, the keys go to the phone as they are.
const PASTE_WAIT_MS = 200;
const MAX_AUDIO_SAMPLES = 2000;
const STALL_US = 50_000;
const CLOCK_JUMP_US = 5_000;
// Left, right and middle. MouseEvent.buttons and Android's MotionEvent.BUTTON_* use the same bits.
const MOUSE_BUTTON_BITS = [1, 2, 4];

export type Send = (data: ArrayBuffer | Uint8Array<ArrayBuffer>) => void;

/**
 * Where the phone's sound is: "off" leaves it on the phone, "needs-click" waits for the browser to allow sound, which
 * it does after someone clicks or types on the page, and "on" plays it here.
 */
export type SoundState = "off" | "needs-click" | "starting" | "on" | "failed";

export interface SessionStats {
	fps: number;
	megabits: number;
	latencyMs: number | null;
}

export interface SessionEvents {
	onStatus?(status: DesktopStatus): void;
	onStats?(stats: SessionStats): void;
	/**
	 * The first picture from a connection is on the canvas. Once for each attach, so a page that reconnects or switches
	 * to a server showing something else hears when the new picture arrives.
	 */
	onFirstFrame?(): void;
	/** The phone wants proof of the pairing code. USB never asks, because adb has already vouched for the computer. */
	onChallenge?(nonce: Uint8Array<ArrayBuffer>): void;
	onAuthenticated?(): void;
	onAuthFailed?(lockedOut: boolean): void;
	/** Another window took the session, and this one has to stay away or they'd keep taking it back. */
	onReplaced?(): void;
	onSound?(state: SoundState): void;
}

interface ClockSample {
	rtt: number;
	offset: number;
}

function nowUs(): number {
	return performance.now() * 1000;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function codecFromConfig(config: Uint8Array): string {
	// SPS NAL: start code, header byte, then profile, constraints and level.
	const start = config[2] === 1 ? 3 : 4;
	const hex = (byte: number | undefined) => (byte ?? 0).toString(16).padStart(2, "0");
	return `avc1.${hex(config[start + 1])}${hex(config[start + 2])}${hex(config[start + 3])}`;
}

export class DesktopSession {
	private readonly context: CanvasRenderingContext2D | null;
	private readonly listeners = new AbortController();
	private readonly statsTimer: ReturnType<typeof setInterval>;
	private readonly fitObserver: ResizeObserver;
	private fitTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly measure = new Measurement();

	private send: Send | null = null;
	private authenticated = false;
	private pingTimer: ReturnType<typeof setInterval> | undefined;
	private status: DesktopStatus | null = null;
	private shownFirstFrame = false;

	private decoder: VideoDecoder | null = null;
	private configBytes: Uint8Array | null = null;
	private codecString: string | null = null;
	private waitingForKey = true;
	private readonly frameTimes = new Map<number, FrameTimes>();

	private clockOffsetUs: number | null = null;
	private readonly clockSamples: ClockSample[] = [];

	private readonly second = { frames: 0, bytes: 0, latencyTotal: 0, latencyCount: 0 };
	private readonly heldKeys = new Set<number>();
	private heldButtons = 0;
	private pointerAt: [number, number] = [0, 0];
	private pendingMove = false;
	private moveTimer: ReturnType<typeof setTimeout> | undefined;
	private lastMoveAt = 0;
	private pasteTimer: ReturnType<typeof setTimeout> | undefined;

	private sharp = false;
	/** The last shape asked for, so a window that hasn't changed doesn't restart the encoder. */
	private lastFit = "";

	private readonly audio = new AudioPlayer();
	private soundWanted = false;
	private readonly audioTransitUs: number[] = [];
	// Packets that arrived much later after the one before than they were recorded after it: the link stalled.
	private readonly audioStalls = { count: 0, worstMs: 0, lastCaptureUs: 0, lastArrivalUs: 0 };
	/** The phone's clipboard, waiting for this window to have focus, which writing to the clipboard needs. */
	private phoneClipboard: string | null = null;

	constructor(
		private readonly canvas: HTMLCanvasElement,
		private readonly events: SessionEvents,
	) {
		this.context = canvas.getContext("2d", { alpha: false, desynchronized: true });
		this.listenForInput();
		this.statsTimer = setInterval(() => this.reportStats(), STATS_INTERVAL_MS);
		this.fitObserver = new ResizeObserver(() => this.fitSoon());
		this.fitObserver.observe(canvas);
	}

	get isConnected(): boolean {
		return this.authenticated;
	}

	get currentStatus(): DesktopStatus | null {
		return this.status;
	}

	get soundState(): SoundState {
		if (!this.soundWanted) {
			return "off";
		}
		if (this.status?.audio === "failed") {
			return "failed";
		}
		if (!this.audio.isRunning) {
			return "needs-click";
		}
		return this.status?.audio === "on" ? "on" : "starting";
	}

	/**
	 * Draws the desktop at the phone's own density, with more pixels to match. Sharper, and apps such as Discord need
	 * it to lay out, but each frame takes longer to encode. Turning it on restarts the desktop's apps that need it,
	 * since they only take up the new density from a fresh start.
	 */
	setSharp(on: boolean) {
		this.sharp = on;
		this.fitNow();
	}

	/** Plays the phone's sound here, or leaves it on the phone. */
	setSound(on: boolean) {
		this.soundWanted = on;
		if (on) {
			void this.enableSound();
		} else {
			this.sendIfAuthenticated(new Uint8Array([MessageType.AudioControl, 0]));
			void this.audio.stop();
		}
		this.events.onSound?.(this.soundState);
	}

	/** A new connection to the phone is open. */
	attach(send: Send) {
		this.send = send;
		this.authenticated = false;
		this.shownFirstFrame = false;
	}

	/** That connection has gone. The server has already lifted everything it was holding. */
	detach() {
		clearInterval(this.pingTimer);
		clearTimeout(this.moveTimer);
		this.moveTimer = undefined;
		this.pendingMove = false;
		clearTimeout(this.pasteTimer);
		this.pasteTimer = undefined;
		this.releaseHeldKeys();
		this.heldButtons = 0;
		this.send = null;
		this.authenticated = false;
	}

	/** Asks the server to end the session for good. */
	stop() {
		this.sendIfAuthenticated(new Uint8Array([MessageType.Stop]));
	}

	dispose() {
		this.detach();
		this.listeners.abort();
		this.fitObserver.disconnect();
		clearTimeout(this.fitTimer);
		clearInterval(this.statsTimer);
		if (this.decoder && this.decoder.state !== "closed") {
			this.decoder.close();
		}
		void this.audio.stop();
	}

	/** The answer to onChallenge: an HMAC of the nonce. */
	answerChallenge(signature: Uint8Array) {
		const message = new Uint8Array(1 + signature.length);
		message[0] = MessageType.AuthResponse;
		message.set(signature, 1);
		this.send?.(message);
	}

	receive(data: ArrayBuffer) {
		const view = new DataView(data);
		switch (view.getUint8(0)) {
			case MessageType.Video:
				this.onVideo(view, data);
				break;
			case MessageType.Status:
				this.onStatus(JSON.parse(new TextDecoder().decode(new Uint8Array(data, 1))) as DesktopStatus);
				break;
			case MessageType.Pong:
				this.onPong(view);
				break;
			case MessageType.AuthChallenge:
				this.events.onChallenge?.(new Uint8Array(data, 1));
				break;
			case MessageType.AuthResult:
				this.onAuthResult(view.getUint8(1));
				break;
			case MessageType.Replaced:
				this.events.onReplaced?.();
				break;
			case MessageType.Audio:
				this.onAudio(view);
				break;
			case MessageType.Clipboard:
				this.phoneClipboard = new TextDecoder().decode(new Uint8Array(data, 1));
				this.copyPhoneClipboard();
				break;
		}
	}

	private sendIfAuthenticated(data: ArrayBuffer | Uint8Array<ArrayBuffer>) {
		if (this.authenticated) {
			this.send?.(data);
		}
	}

	private onAuthResult(result: number) {
		if (result !== AUTH_OK) {
			this.events.onAuthFailed?.(result === AUTH_LOCKED_OUT);
			return;
		}
		this.authenticated = true;
		this.canvas.focus();
		this.waitingForKey = true;
		this.clockSamples.length = 0;
		this.clockOffsetUs = null;
		this.ping();
		this.pingTimer = setInterval(() => this.ping(), PING_INTERVAL_MS);
		this.lastFit = "";
		this.fitNow();
		if (this.soundWanted) {
			void this.enableSound();
		}
		this.events.onAuthenticated?.();
	}

	// Fitting the window

	private fitSoon() {
		clearTimeout(this.fitTimer);
		this.fitTimer = setTimeout(() => this.fitNow(), FIT_DELAY_MS);
	}

	/** Asks for the desktop to take the window's shape. The server ignores this if a size was set for it. */
	private fitNow() {
		const box = this.canvas.getBoundingClientRect();
		const [width, height] = fitDesktopSize(box.width, box.height);
		const shape = `${width}x${height}${this.sharp ? " sharp" : ""}`;
		if (!this.authenticated || shape === this.lastFit) {
			return;
		}
		this.lastFit = shape;
		const buffer = new ArrayBuffer(10);
		const view = new DataView(buffer);
		view.setUint8(0, MessageType.Resize);
		view.setInt32(1, width);
		view.setInt32(5, height);
		view.setUint8(9, this.sharp ? RESIZE_SHARP : 0);
		this.send?.(buffer);
	}

	private onStatus(next: DesktopStatus) {
		const soundBefore = this.soundState;
		this.status = next;
		if (this.canvas.width !== next.width || this.canvas.height !== next.height) {
			this.canvas.width = next.width;
			this.canvas.height = next.height;
		}
		if (!next.usable) {
			this.releaseHeldKeys();
		}
		this.events.onStatus?.(next);
		if (this.soundState !== soundBefore) {
			this.events.onSound?.(this.soundState);
		}
	}

	// Sound

	/** Opens the sound output, then asks the phone for its sound. Tried again on each click until the browser allows it. */
	private async enableSound() {
		const running = await this.audio.start();
		if (this.soundWanted && running) {
			this.sendIfAuthenticated(new Uint8Array([MessageType.AudioControl, 1]));
		}
		this.events.onSound?.(this.soundState);
	}

	/** Browsers allow sound only from inside a click or key press. */
	private allowSound() {
		if (this.soundWanted && !this.audio.isRunning) {
			void this.enableSound();
		}
	}

	private onAudio(view: DataView) {
		this.audio.play(view, AUDIO_HEADER_BYTES);
		const arrivalUs = nowUs();
		const captureUs = Number(view.getBigInt64(1));
		const stalls = this.audioStalls;
		const lateUs = arrivalUs - stalls.lastArrivalUs - (captureUs - stalls.lastCaptureUs);
		if (captureUs - stalls.lastCaptureUs < STALL_US && lateUs > STALL_US) {
			stalls.count++;
			stalls.worstMs = Math.max(stalls.worstMs, Math.round(lateUs / 1000));
		}
		stalls.lastCaptureUs = captureUs;
		stalls.lastArrivalUs = arrivalUs;
		if (this.clockOffsetUs !== null) {
			this.audioTransitUs.push(arrivalUs - (captureUs - this.clockOffsetUs));
			if (this.audioTransitUs.length > MAX_AUDIO_SAMPLES) {
				this.audioTransitUs.shift();
			}
		}
	}

	/** How the sound is doing, for tools/measure.ts. */
	audioReport() {
		const delay = this.audio.outputDelay;
		return {
			state: this.soundState,
			transitMs: percentiles(this.audioTransitUs),
			outputDelayMs: delay === null ? null : Math.round(delay * 1000),
			stalls: this.audioStalls.count,
			worstStallMs: this.audioStalls.worstMs,
			...this.audio.counts,
		};
	}

	// Clipboard

	private copyPhoneClipboard() {
		const text = this.phoneClipboard;
		if (text === null || !navigator.clipboard || !document.hasFocus()) {
			return;
		}
		this.phoneClipboard = null;
		navigator.clipboard.writeText(text).catch((error: unknown) => {
			console.info("couldn't copy the phone's clipboard here", error);
			this.phoneClipboard ??= text;
		});
	}

	/** Puts text on the phone's clipboard, and pastes it there if asked. */
	private sendClipboard(text: string, paste: boolean): boolean {
		const bytes = new TextEncoder().encode(text);
		if (bytes.length === 0 || bytes.length > MAX_CLIPBOARD_BYTES) {
			return false;
		}
		const message = new Uint8Array(2 + bytes.length);
		message[0] = MessageType.SetClipboard;
		message[1] = paste ? CLIPBOARD_PASTE : 0;
		message.set(bytes, 2);
		this.sendIfAuthenticated(message);
		return true;
	}

	/** Ctrl+V, so the phone pastes what it already has. */
	private sendPasteKeys() {
		const v = keycodeFor("KeyV") as number;
		this.sendKey(KEY_DOWN, v, META_CTRL);
		this.sendKey(KEY_UP, v, META_CTRL);
	}

	// Clock

	private ping() {
		const buffer = new ArrayBuffer(9);
		const view = new DataView(buffer);
		view.setUint8(0, MessageType.Ping);
		view.setFloat64(1, nowUs());
		this.sendIfAuthenticated(buffer);
	}

	private onPong(view: DataView) {
		const sentUs = view.getFloat64(1);
		const serverUs = Number(view.getBigInt64(9));
		const receivedUs = nowUs();
		this.clockSamples.push({ rtt: receivedUs - sentUs, offset: serverUs - (sentUs + receivedUs) / 2 });
		if (this.clockSamples.length > CLOCK_SAMPLES) {
			this.clockSamples.shift();
		}
		// The sample with the shortest round trip has the least queueing, so it's the most accurate.
		const offset = this.clockSamples.reduce((best, sample) => (sample.rtt < best.rtt ? sample : best)).offset;
		if (this.clockOffsetUs !== null && Math.abs(offset - this.clockOffsetUs) > CLOCK_JUMP_US) {
			// Sound timings so far were measured with a clock that was off.
			this.audioTransitUs.length = 0;
		}
		this.clockOffsetUs = offset;
	}

	// Video

	private createDecoder() {
		if (this.decoder && this.decoder.state !== "closed") {
			this.decoder.close();
		}
		this.decoder = new VideoDecoder({
			output: (frame) => this.onDecoded(frame),
			error: (error) => this.onDecodeError(error),
		});
		this.decoder.configure({
			codec: this.codecString as string,
			optimizeForLatency: true,
			hardwareAcceleration: "prefer-hardware",
		});
		this.frameTimes.clear();
		this.waitingForKey = true;
	}

	private onDecodeError(error: DOMException) {
		console.warn("decoder error", error);
		this.requestKeyFrame();
		this.createDecoder();
	}

	private requestKeyFrame() {
		this.sendIfAuthenticated(new Uint8Array([MessageType.KeyFrame]));
	}

	private onVideo(view: DataView, buffer: ArrayBuffer) {
		const flags = view.getUint8(1);
		const captureUs = Number(view.getBigInt64(2));
		const encodedUs = Number(view.getBigInt64(10));
		const sentUs = Number(view.getBigInt64(18));
		const data = new Uint8Array(buffer, VIDEO_HEADER_BYTES);
		this.second.bytes += buffer.byteLength;
		this.measure.bytes += buffer.byteLength;

		if (flags & FLAG_CONFIG) {
			// New settings mean a new size, which a decoder doesn't always take in its stride.
			const changed =
				!this.configBytes ||
				this.configBytes.length !== data.length ||
				this.configBytes.some((byte, i) => byte !== data[i]);
			this.configBytes = data.slice();
			this.codecString = codecFromConfig(this.configBytes);
			if (changed || !this.decoder || this.decoder.state === "closed") {
				this.createDecoder();
			}
			return;
		}
		if (this.decoder?.state !== "configured") {
			return;
		}
		const key = (flags & FLAG_KEY) !== 0;
		if (this.waitingForKey && !key) {
			return;
		}
		if (this.decoder.decodeQueueSize > MAX_DECODE_QUEUE) {
			// Falling behind. Skip to a key frame instead of showing ever older video.
			this.waitingForKey = true;
			this.requestKeyFrame();
			return;
		}
		this.waitingForKey = false;

		let payload = data;
		if (key && this.configBytes) {
			// Without a codec description, WebCodecs needs the parameter sets inline on key frames.
			payload = new Uint8Array(this.configBytes.length + data.length);
			payload.set(this.configBytes);
			payload.set(data, this.configBytes.length);
		}
		this.frameTimes.set(captureUs, { encodedUs, sentUs, receivedUs: nowUs() });
		if (this.frameTimes.size > MAX_TRACKED_FRAMES) {
			this.frameTimes.clear();
		}
		this.decoder.decode(
			new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: captureUs, data: payload }),
		);
	}

	private onDecoded(frame: VideoFrame) {
		const decodedUs = nowUs();
		this.context?.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
		this.second.frames++;
		if (!this.shownFirstFrame) {
			this.shownFirstFrame = true;
			this.events.onFirstFrame?.();
		}

		const times = this.frameTimes.get(frame.timestamp);
		this.frameTimes.delete(frame.timestamp);
		if (times && this.clockOffsetUs !== null) {
			const latency = decodedUs - (frame.timestamp - this.clockOffsetUs);
			this.second.latencyTotal += latency;
			this.second.latencyCount++;
			if (this.measure.active) {
				this.measure.record(frame.timestamp, times, decodedUs, latency, this.clockOffsetUs);
			}
		}
		if (this.measure.active) {
			this.measure.probe(frame, decodedUs);
		}
		frame.close();
	}

	private reportStats() {
		const { frames, bytes, latencyTotal, latencyCount } = this.second;
		this.events.onStats?.({
			fps: frames,
			megabits: (bytes * 8) / 1e6,
			latencyMs: latencyCount > 0 ? latencyTotal / latencyCount / 1000 : null,
		});
		this.second.frames = 0;
		this.second.bytes = 0;
		this.second.latencyTotal = 0;
		this.second.latencyCount = 0;
	}

	// Input

	private toDisplay(event: MouseEvent): [number, number] {
		// The canvas uses object-fit: contain, so work out where the picture actually sits.
		const { canvas } = this;
		const box = canvas.getBoundingClientRect();
		const scale = Math.min(box.width / canvas.width, box.height / canvas.height);
		const left = box.left + (box.width - canvas.width * scale) / 2;
		const top = box.top + (box.height - canvas.height * scale) / 2;
		return [Math.round((event.clientX - left) / scale), Math.round((event.clientY - top) / scale)];
	}

	private sendMouse(action: number, button: number, x: number, y: number) {
		const buffer = new ArrayBuffer(11);
		const view = new DataView(buffer);
		view.setUint8(0, MessageType.Mouse);
		view.setUint8(1, action);
		view.setUint8(2, button);
		view.setInt32(3, x);
		view.setInt32(7, y);
		this.sendIfAuthenticated(buffer);
	}

	private sendScroll(x: number, y: number, horizontal: number, vertical: number) {
		const buffer = new ArrayBuffer(17);
		const view = new DataView(buffer);
		view.setUint8(0, MessageType.Scroll);
		view.setInt32(1, x);
		view.setInt32(5, y);
		view.setFloat32(9, horizontal);
		view.setFloat32(13, vertical);
		this.sendIfAuthenticated(buffer);
	}

	private sendKey(action: number, code: number, meta: number) {
		const buffer = new ArrayBuffer(10);
		const view = new DataView(buffer);
		view.setUint8(0, MessageType.Key);
		view.setUint8(1, action);
		view.setInt32(2, code);
		view.setInt32(6, meta);
		this.sendIfAuthenticated(buffer);
	}

	/** Sends the pointer's latest position now, or as soon as the last move is MOVE_INTERVAL_MS old. */
	private queueMove() {
		this.pendingMove = true;
		const wait = MOVE_INTERVAL_MS - (performance.now() - this.lastMoveAt);
		if (wait <= 0) {
			this.flushMove();
		} else if (this.moveTimer === undefined) {
			this.moveTimer = setTimeout(() => this.flushMove(), wait);
		}
	}

	/** Sends a waiting move, so that a press or scroll after it lands where the pointer really is. */
	private flushMove() {
		clearTimeout(this.moveTimer);
		this.moveTimer = undefined;
		if (!this.pendingMove) return;
		this.pendingMove = false;
		this.lastMoveAt = performance.now();
		this.sendMouse(MOUSE_MOVE, 0, this.pointerAt[0], this.pointerAt[1]);
	}

	/** Whether keys belong to the desktop: the canvas has focus, or nothing in particular does. */
	private hasKeyboard(): boolean {
		const focused = document.activeElement;
		return focused === this.canvas || focused === document.body || focused === null;
	}

	private releaseHeldKeys() {
		for (const code of this.heldKeys) {
			this.sendKey(KEY_UP, code, 0);
		}
		this.heldKeys.clear();
	}

	private syncButtons(buttons: number) {
		this.flushMove();
		const [x, y] = this.pointerAt;
		for (const bit of MOUSE_BUTTON_BITS) {
			if ((this.heldButtons ^ buttons) & bit) {
				this.sendMouse(buttons & bit ? MOUSE_PRESS : MOUSE_RELEASE, bit, x, y);
			}
		}
		this.heldButtons = buttons;
	}

	private releaseHeldButtons() {
		this.syncButtons(0);
	}

	private listenForInput() {
		const { canvas } = this;
		const { signal } = this.listeners;

		// pointerrawupdate fires without waiting for the next frame, which trims input latency where it exists.
		const moveEvent = ("onpointerrawupdate" in window ? "pointerrawupdate" : "pointermove") as "pointermove";
		canvas.addEventListener(
			moveEvent,
			(event) => {
				this.pointerAt = this.toDisplay(event);
				this.queueMove();
			},
			{ signal },
		);

		// Browsers report a second button pressed or released during a drag as a move with a button set.
		canvas.addEventListener(
			"pointermove",
			(event) => {
				if (event.button !== -1) {
					this.pointerAt = this.toDisplay(event);
					this.syncButtons(event.buttons);
				}
			},
			{ signal },
		);

		canvas.addEventListener(
			"pointerdown",
			(event) => {
				event.preventDefault();
				canvas.focus();
				this.allowSound();
				this.pointerAt = this.toDisplay(event);
				this.syncButtons(event.buttons);
				canvas.setPointerCapture(event.pointerId);
			},
			{ signal },
		);

		canvas.addEventListener(
			"pointerup",
			(event) => {
				event.preventDefault();
				this.pointerAt = this.toDisplay(event);
				this.syncButtons(event.buttons);
			},
			{ signal },
		);

		// Without these, a drag the browser gives up on would leave the button held down on the phone.
		canvas.addEventListener("pointercancel", () => this.releaseHeldButtons(), { signal });
		canvas.addEventListener("lostpointercapture", () => this.releaseHeldButtons(), { signal });

		canvas.addEventListener("contextmenu", (event) => event.preventDefault(), { signal });

		canvas.addEventListener(
			"wheel",
			(event) => {
				event.preventDefault();
				this.flushMove();
				const [x, y] = this.toDisplay(event);
				const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 3 : 100;
				this.sendScroll(x, y, event.deltaX / unit, -event.deltaY / unit);
			},
			{ passive: false, signal },
		);

		// Keys only go to the phone while the desktop has focus, so the rest of the page can still be typed in, such as
		// the pairing code before a connection is up.
		window.addEventListener(
			"keydown",
			(event) => {
				const code = keycodeFor(event.code, event.key);
				if (code === undefined || !this.authenticated || !this.hasKeyboard()) {
					return;
				}
				this.allowSound();
				if (isPasteShortcut(event) && this.status?.clipboard) {
					clearTimeout(this.pasteTimer);
					this.pasteTimer = setTimeout(() => {
						this.pasteTimer = undefined;
						this.sendPasteKeys();
					}, PASTE_WAIT_MS);
					return;
				}
				event.preventDefault();
				this.heldKeys.add(code);
				this.sendKey(KEY_DOWN, code, metaState(event));
			},
			{ signal },
		);

		window.addEventListener(
			"keyup",
			(event) => {
				const code = keycodeFor(event.code, event.key);
				if (code === undefined || !this.heldKeys.has(code)) {
					return;
				}
				event.preventDefault();
				this.heldKeys.delete(code);
				this.sendKey(KEY_UP, code, metaState(event));
			},
			{ signal },
		);

		// The computer's clipboard goes to the phone and is pasted there. Anything but text, such as a picture, can't
		// be carried over, so the phone pastes whatever it already holds.
		window.addEventListener(
			"paste",
			(event) => {
				if (!this.authenticated || !this.hasKeyboard()) {
					return;
				}
				event.preventDefault();
				clearTimeout(this.pasteTimer);
				this.pasteTimer = undefined;
				if (
					!this.status?.clipboard ||
					!this.sendClipboard(event.clipboardData?.getData("text/plain") ?? "", true)
				) {
					this.sendPasteKeys();
				}
			},
			{ signal },
		);

		window.addEventListener("focus", () => this.copyPhoneClipboard(), { signal });

		// A key or button released while the window is in the background would otherwise stay down on the phone.
		window.addEventListener(
			"blur",
			() => {
				this.releaseHeldKeys();
				this.releaseHeldButtons();
			},
			{ signal },
		);
	}

	// Measurement, for tools/measure.ts

	private click(x: number, y: number) {
		this.sendMouse(MOUSE_MOVE, 0, x, y);
		this.sendMouse(MOUSE_PRESS, 1, x, y);
		this.sendMouse(MOUSE_RELEASE, 1, x, y);
	}

	/** Time from sending a click to the first decoded frame that looks different. */
	async measureClicks({
		targets,
		count = 30,
		settleMs = 900,
		timeoutMs = 2000,
	}: {
		targets: [number, number][];
		count?: number;
		settleMs?: number;
		timeoutMs?: number;
	}) {
		this.measure.start();
		const samples: number[] = [];
		let missed = 0;
		for (let i = 0; i < count; i++) {
			await sleep(settleMs);
			const [x, y] = targets[i % targets.length] as [number, number];
			const sentUs = nowUs();
			const change = this.measure.waitForChange(timeoutMs);
			this.click(x, y);
			const changedUs = await change;
			if (changedUs === null) {
				missed++;
			} else {
				samples.push(changedUs - sentUs);
			}
		}
		this.measure.active = false;
		return { clickToChange: percentiles(samples), missed };
	}

	/**
	 * Time from moving the pointer to the first decoded frame that looks different: how far the phone's own cursor
	 * trails the mouse. Only hovers, so nothing on the phone is clicked.
	 */
	async measureHover({
		start,
		count = 40,
		step = 80,
		settleMs = 350,
		timeoutMs = 1000,
	}: {
		start: [number, number];
		count?: number;
		step?: number;
		settleMs?: number;
		timeoutMs?: number;
	}) {
		this.measure.start();
		const samples: number[] = [];
		let missed = 0;
		const [x0, y0] = start;
		this.sendMouse(MOUSE_MOVE, 0, x0, y0);
		for (let i = 0; i < count; i++) {
			await sleep(settleMs);
			const x = x0 + (i % 2 === 0 ? step : 0);
			const sentUs = nowUs();
			const change = this.measure.waitForChange(timeoutMs);
			this.sendMouse(MOUSE_MOVE, 0, x, y0);
			const changedUs = await change;
			if (changedUs === null) {
				missed++;
			} else {
				samples.push(changedUs - sentUs);
			}
		}
		this.measure.active = false;
		return { moveToChange: percentiles(samples), missed, latencyMs: this.measure.summary() };
	}

	/** Drags a window in a circle, which makes the desktop redraw constantly. */
	async measureDrag({ seconds, start, radius = 150 }: { seconds: number; start: [number, number]; radius?: number }) {
		this.measure.start();
		const [cx, cy] = start;
		this.sendMouse(MOUSE_MOVE, 0, cx, cy);
		this.sendMouse(MOUSE_PRESS, 1, cx, cy);
		const startedAt = performance.now();
		const end = startedAt + seconds * 1000;
		while (performance.now() < end) {
			const angle = ((performance.now() - startedAt) / 1000) * 2;
			this.sendMouse(
				MOUSE_MOVE,
				0,
				Math.round(cx + radius * (Math.cos(angle) - 1)),
				Math.round(cy + radius * Math.sin(angle)),
			);
			await sleep(16);
		}
		this.sendMouse(MOUSE_MOVE, 0, cx, cy);
		this.sendMouse(MOUSE_RELEASE, 1, cx, cy);
		const elapsed = (performance.now() - startedAt) / 1000;
		this.measure.active = false;
		return {
			seconds: Math.round(elapsed),
			decodedFps: Math.round((this.measure.frames / elapsed) * 10) / 10,
			distinctFps: Math.round((this.measure.distinct / elapsed) * 10) / 10,
			megabitsPerSecond: Math.round((this.measure.bytes * 8) / elapsed / 1e5) / 10,
			droppedFrames: this.status ? this.status.dropped : null,
			latencyMs: this.measure.summary(),
		};
	}
}

/** Goes fullscreen, or back. Lets Esc and browser shortcuts reach the phone, where the browser allows it. */
export async function toggleFullscreen(canvas: HTMLCanvasElement) {
	if (document.fullscreenElement) {
		await document.exitFullscreen();
		return;
	}
	await document.documentElement.requestFullscreen();
	const keyboard = (navigator as Navigator & { keyboard?: { lock?: () => Promise<void> } }).keyboard;
	await keyboard?.lock?.();
	canvas.focus();
}
