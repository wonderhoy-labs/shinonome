// Generated from web/src/phone-page and web/src/session. Change those and run pnpm build:phone-page.
(function() {
	// ../packages/shinonome/src/session/audio.ts
	var SAMPLE_RATE = 48e3;
	var BYTES_PER_FRAME = 4;
	var START_LEAD_S = .03;
	var LEAD_STEP_S = .01;
	var MAX_START_LEAD_S = .1;
	var MIN_LEAD_S = .002;
	var QUIET_GAP_S = .1;
	/**
	* When a packet should start, given the time now, when the last one ends and the lead to start with, or null to drop
	* it. Exported for tests.
	*/
	function scheduleAt(now, queuedUntil, startLead = START_LEAD_S) {
		const lead = queuedUntil - now;
		if (lead < MIN_LEAD_S) return now + startLead;
		if (lead > startLead + .03) return null;
		return queuedUntil;
	}
	/** Splits interleaved 16-bit little-endian stereo into two channels of floats. Exported for tests. */
	function decodePcm(view, offset, left, right) {
		const frames = Math.min(left.length, Math.floor((view.byteLength - offset) / BYTES_PER_FRAME));
		for (let i = 0, at = offset; i < frames; i++, at += BYTES_PER_FRAME) {
			left[i] = view.getInt16(at, true) / 32768;
			right[i] = view.getInt16(at + 2, true) / 32768;
		}
	}
	var AudioPlayer = class {
		context = null;
		queuedUntil = 0;
		lastArrival = Number.NEGATIVE_INFINITY;
		startLead = START_LEAD_S;
		counts = {
			packets: 0,
			starts: 0,
			underruns: 0,
			dropped: 0,
			leadMs: START_LEAD_S * 1e3
		};
		get isRunning() {
			return this.context?.state === "running";
		}
		/**
		* Opens the sound output. Browsers only allow that after someone has clicked or typed on the page, so this
		* resolves to false until then, and should be tried again from such an event.
		*/
		async start() {
			if (!this.context) this.context = new AudioContext({
				sampleRate: SAMPLE_RATE,
				latencyHint: "interactive"
			});
			if (this.context.state !== "running") await Promise.race([this.context.resume(), new Promise((resolve) => setTimeout(resolve, 200))]);
			return this.isRunning;
		}
		/** Plays the PCM that starts at offset in view. */
		play(view, offset) {
			const context = this.context;
			if (context?.state !== "running") return;
			const frames = Math.floor((view.byteLength - offset) / BYTES_PER_FRAME);
			if (frames <= 0) return;
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
				if (quiet) this.counts.starts++;
				else {
					this.counts.underruns++;
					this.startLead = Math.min(MAX_START_LEAD_S, this.startLead + LEAD_STEP_S);
					this.counts.leadMs = Math.round(this.startLead * 1e3);
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
		get outputDelay() {
			const context = this.context;
			if (context?.state !== "running") return null;
			return Math.max(0, this.queuedUntil - context.currentTime) + context.baseLatency + (context.outputLatency || 0);
		}
		async stop() {
			const context = this.context;
			this.context = null;
			this.queuedUntil = 0;
			this.lastArrival = Number.NEGATIVE_INFINITY;
			await context?.close();
		}
	};
	// ../packages/shinonome/src/session/debug.ts
	/** What tools/measure.mjs uses to drive a page. A session can come and go underneath it. */
	function exposeDebugApi(getSession, shell) {
		const session = () => {
			const current = getSession();
			if (!current) throw new Error("No session is running.");
			return current;
		};
		window.shinonome = {
			isConnected: () => getSession()?.isConnected ?? false,
			getStatus: () => getSession()?.currentStatus ?? null,
			measureClicks: (options) => session().measureClicks(options),
			measureDrag: (options) => session().measureDrag(options),
			measureHover: (options) => session().measureHover(options),
			audioReport: () => session().audioReport(),
			...shell ? { shell } : {}
		};
	}
	// ../packages/shinonome/src/session/fit.ts
	var MAX_WIDTH = 1920;
	var MAX_HEIGHT = 1200;
	var MIN_RATIO = 1;
	var MAX_RATIO = 21 / 9;
	function even(value) {
		return Math.round(value / 2) * 2;
	}
	function fitDesktopSize(windowWidth, windowHeight) {
		if (windowWidth <= 0 || windowHeight <= 0) return [MAX_WIDTH, even(MAX_WIDTH * 9 / 16)];
		const ratio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, windowWidth / windowHeight));
		const height = MAX_WIDTH / ratio;
		return height <= MAX_HEIGHT ? [MAX_WIDTH, even(height)] : [even(MAX_HEIGHT * ratio), MAX_HEIGHT];
	}
	// ../packages/shinonome/src/session/keyboard.ts
	var META_SHIFT = 65;
	var META_ALT = 18;
	var META_CTRL = 12288;
	var META_SYSTEM = 196608;
	var KEYCODE_CTRL_LEFT = 113;
	var KEYCODE_CTRL_RIGHT = 114;
	var KEYCODE_META_LEFT = 117;
	var isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
	/** KeyboardEvent.code to Android's KeyEvent.KEYCODE_*. */
	var KEYCODES = {
		Digit0: 7,
		Digit1: 8,
		Digit2: 9,
		Digit3: 10,
		Digit4: 11,
		Digit5: 12,
		Digit6: 13,
		Digit7: 14,
		Digit8: 15,
		Digit9: 16,
		KeyA: 29,
		KeyB: 30,
		KeyC: 31,
		KeyD: 32,
		KeyE: 33,
		KeyF: 34,
		KeyG: 35,
		KeyH: 36,
		KeyI: 37,
		KeyJ: 38,
		KeyK: 39,
		KeyL: 40,
		KeyM: 41,
		KeyN: 42,
		KeyO: 43,
		KeyP: 44,
		KeyQ: 45,
		KeyR: 46,
		KeyS: 47,
		KeyT: 48,
		KeyU: 49,
		KeyV: 50,
		KeyW: 51,
		KeyX: 52,
		KeyY: 53,
		KeyZ: 54,
		Comma: 55,
		Period: 56,
		Tab: 61,
		Space: 62,
		Enter: 66,
		Backspace: 67,
		Backquote: 68,
		Minus: 69,
		Equal: 70,
		BracketLeft: 71,
		BracketRight: 72,
		Backslash: 73,
		Semicolon: 74,
		Quote: 75,
		Slash: 76,
		ArrowUp: 19,
		ArrowDown: 20,
		ArrowLeft: 21,
		ArrowRight: 22,
		PageUp: 92,
		PageDown: 93,
		Escape: 111,
		Delete: 112,
		CapsLock: 115,
		Home: 122,
		End: 123,
		Insert: 124,
		F1: 131,
		F2: 132,
		F3: 133,
		F4: 134,
		F5: 135,
		F6: 136,
		F7: 137,
		F8: 138,
		F9: 139,
		F10: 140,
		F11: 141,
		F12: 142,
		ShiftLeft: 59,
		ShiftRight: 60,
		AltLeft: 57,
		AltRight: 58,
		Numpad0: 144,
		Numpad1: 145,
		Numpad2: 146,
		Numpad3: 147,
		Numpad4: 148,
		Numpad5: 149,
		Numpad6: 150,
		Numpad7: 151,
		Numpad8: 152,
		Numpad9: 153,
		NumpadDivide: 154,
		NumpadMultiply: 155,
		NumpadSubtract: 156,
		NumpadAdd: 157,
		NumpadDecimal: 158,
		NumpadEnter: 160,
		NumpadEqual: 161,
		ControlLeft: isMac ? KEYCODE_META_LEFT : KEYCODE_CTRL_LEFT,
		ControlRight: isMac ? KEYCODE_META_LEFT : KEYCODE_CTRL_RIGHT,
		MetaLeft: isMac ? KEYCODE_CTRL_LEFT : KEYCODE_META_LEFT,
		MetaRight: isMac ? KEYCODE_CTRL_LEFT : KEYCODE_META_LEFT
	};
	/**
	* The browser's paste shortcut. The page lets the browser have it, so that the browser follows with a paste event
	* carrying the computer's clipboard.
	*/
	function isPasteShortcut(event) {
		return event.code === "KeyV" && (isMac ? event.metaKey : event.ctrlKey) && !event.altKey;
	}
	function keycodeFor(code) {
		return KEYCODES[code];
	}
	function metaState(event) {
		let meta = 0;
		if (event.shiftKey) meta |= META_SHIFT;
		if (event.altKey) meta |= META_ALT;
		if (event.metaKey) meta |= isMac ? META_CTRL : META_SYSTEM;
		if (event.ctrlKey) meta |= isMac ? META_SYSTEM : META_CTRL;
		return meta;
	}
	// ../packages/shinonome/src/session/measure.ts
	var PROBE_WIDTH = 240;
	var PROBE_HEIGHT = 135;
	var PROBE_CHANGE_LEVEL = 10;
	var PROBE_CHANGED_CELLS = 3;
	var LATENCY_STAGES = [
		"captureToEncoded",
		"encodedToSent",
		"sentToReceived",
		"receivedToDecoded",
		"total"
	];
	function percentiles(values) {
		if (values.length === 0) return null;
		const sorted = [...values].sort((a, b) => a - b);
		const at = (p) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] / 100) / 10;
		return {
			p50: at(.5),
			p95: at(.95),
			p99: at(.99),
			max: at(1),
			count: sorted.length
		};
	}
	var Measurement = class {
		active = false;
		bytes = 0;
		frames = 0;
		distinct = 0;
		latencies = {};
		probeContext = null;
		previous = null;
		waiter = null;
		start() {
			this.active = true;
			this.bytes = 0;
			this.frames = 0;
			this.distinct = 0;
			for (const stage of LATENCY_STAGES) this.latencies[stage] = [];
			this.probeContext ??= new OffscreenCanvas(PROBE_WIDTH, PROBE_HEIGHT).getContext("2d", { willReadFrequently: true });
		}
		record(captureUs, times, decodedUs, total, clockOffsetUs) {
			const sentLocalUs = times.sentUs - clockOffsetUs;
			this.latencies.captureToEncoded.push(times.encodedUs - captureUs);
			this.latencies.encodedToSent.push(times.sentUs - times.encodedUs);
			this.latencies.sentToReceived.push(times.receivedUs - sentLocalUs);
			this.latencies.receivedToDecoded.push(decodedUs - times.receivedUs);
			this.latencies.total.push(total);
		}
		probe(frame, decodedUs) {
			this.frames++;
			const context = this.probeContext;
			if (!context) return;
			context.drawImage(frame, 0, 0, PROBE_WIDTH, PROBE_HEIGHT);
			const pixels = context.getImageData(0, 0, PROBE_WIDTH, PROBE_HEIGHT).data;
			let changed = 0;
			if (this.previous) {
				for (let i = 1; i < pixels.length; i += 4) if (Math.abs(pixels[i] - this.previous[i]) > PROBE_CHANGE_LEVEL) changed++;
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
		waitForChange(timeoutMs) {
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
	};
	// ../packages/shinonome/src/session/protocol.ts
	var MessageType = {
		Video: 1,
		Status: 2,
		Pong: 3,
		AuthChallenge: 4,
		AuthResult: 5,
		Replaced: 6,
		Audio: 7,
		Clipboard: 8,
		Mouse: 16,
		Scroll: 17,
		Key: 18,
		Ping: 19,
		Stop: 20,
		AuthResponse: 21,
		KeyFrame: 22,
		Resize: 23,
		AudioControl: 24,
		SetClipboard: 25
	};
	// ../packages/shinonome/src/session/desktop-session.ts
	var PING_INTERVAL_MS = 2e3;
	var CLOCK_SAMPLES = 8;
	var MAX_DECODE_QUEUE = 6;
	var MAX_TRACKED_FRAMES = 240;
	var STATS_INTERVAL_MS = 1e3;
	var FIT_DELAY_MS = 400;
	var MOVE_INTERVAL_MS = 4;
	var PASTE_WAIT_MS = 200;
	var MAX_AUDIO_SAMPLES = 2e3;
	var STALL_US = 5e4;
	var CLOCK_JUMP_US = 5e3;
	var MOUSE_BUTTON_BITS = [
		1,
		2,
		4
	];
	function nowUs() {
		return performance.now() * 1e3;
	}
	function sleep(ms) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
	function codecFromConfig(config) {
		const start = config[2] === 1 ? 3 : 4;
		const hex = (byte) => (byte ?? 0).toString(16).padStart(2, "0");
		return `avc1.${hex(config[start + 1])}${hex(config[start + 2])}${hex(config[start + 3])}`;
	}
	var DesktopSession = class {
		canvas;
		events;
		context;
		listeners = new AbortController();
		statsTimer;
		fitObserver;
		fitTimer;
		measure = new Measurement();
		send = null;
		authenticated = false;
		pingTimer;
		status = null;
		shownFirstFrame = false;
		decoder = null;
		configBytes = null;
		codecString = null;
		waitingForKey = true;
		frameTimes = /* @__PURE__ */ new Map();
		clockOffsetUs = null;
		clockSamples = [];
		second = {
			frames: 0,
			bytes: 0,
			latencyTotal: 0,
			latencyCount: 0
		};
		heldKeys = /* @__PURE__ */ new Set();
		heldButtons = 0;
		pointerAt = [0, 0];
		pendingMove = false;
		moveTimer;
		lastMoveAt = 0;
		pasteTimer;
		sharp = false;
		/** The last shape asked for, so a window that hasn't changed doesn't restart the encoder. */
		lastFit = "";
		audio = new AudioPlayer();
		soundWanted = false;
		audioTransitUs = [];
		audioStalls = {
			count: 0,
			worstMs: 0,
			lastCaptureUs: 0,
			lastArrivalUs: 0
		};
		/** The phone's clipboard, waiting for this window to have focus, which writing to the clipboard needs. */
		phoneClipboard = null;
		constructor(canvas, events) {
			this.canvas = canvas;
			this.events = events;
			this.context = canvas.getContext("2d", {
				alpha: false,
				desynchronized: true
			});
			this.listenForInput();
			this.statsTimer = setInterval(() => this.reportStats(), STATS_INTERVAL_MS);
			this.fitObserver = new ResizeObserver(() => this.fitSoon());
			this.fitObserver.observe(canvas);
		}
		get isConnected() {
			return this.authenticated;
		}
		get currentStatus() {
			return this.status;
		}
		get soundState() {
			if (!this.soundWanted) return "off";
			if (this.status?.audio === "failed") return "failed";
			if (!this.audio.isRunning) return "needs-click";
			return this.status?.audio === "on" ? "on" : "starting";
		}
		/**
		* Draws the desktop at the phone's own density, with more pixels to match. Sharper, and apps such as Discord need
		* it to draw their text, but each frame takes longer to encode.
		*/
		setSharp(on) {
			this.sharp = on;
			this.fitNow();
		}
		/** Plays the phone's sound here, or leaves it on the phone. */
		setSound(on) {
			this.soundWanted = on;
			if (on) this.enableSound();
			else {
				this.sendIfAuthenticated(new Uint8Array([MessageType.AudioControl, 0]));
				this.audio.stop();
			}
			this.events.onSound?.(this.soundState);
		}
		/** A new connection to the phone is open. */
		attach(send) {
			this.send = send;
			this.authenticated = false;
		}
		/** That connection has gone. The server has already lifted everything it was holding. */
		detach() {
			clearInterval(this.pingTimer);
			clearTimeout(this.moveTimer);
			this.moveTimer = void 0;
			this.pendingMove = false;
			clearTimeout(this.pasteTimer);
			this.pasteTimer = void 0;
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
			if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
			this.audio.stop();
		}
		/** The answer to onChallenge: an HMAC of the nonce. */
		answerChallenge(signature) {
			const message = new Uint8Array(1 + signature.length);
			message[0] = MessageType.AuthResponse;
			message.set(signature, 1);
			this.send?.(message);
		}
		receive(data) {
			const view = new DataView(data);
			switch (view.getUint8(0)) {
				case MessageType.Video:
					this.onVideo(view, data);
					break;
				case MessageType.Status:
					this.onStatus(JSON.parse(new TextDecoder().decode(new Uint8Array(data, 1))));
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
			}
		}
		sendIfAuthenticated(data) {
			if (this.authenticated) this.send?.(data);
		}
		onAuthResult(result) {
			if (result !== 1) {
				this.events.onAuthFailed?.(result === 2);
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
			if (this.soundWanted) this.enableSound();
			this.events.onAuthenticated?.();
		}
		fitSoon() {
			clearTimeout(this.fitTimer);
			this.fitTimer = setTimeout(() => this.fitNow(), FIT_DELAY_MS);
		}
		/** Asks for the desktop to take the window's shape. The server ignores this if a size was set for it. */
		fitNow() {
			const box = this.canvas.getBoundingClientRect();
			const [width, height] = fitDesktopSize(box.width, box.height);
			const shape = `${width}x${height}${this.sharp ? " sharp" : ""}`;
			if (!this.authenticated || shape === this.lastFit) return;
			this.lastFit = shape;
			const buffer = /* @__PURE__ */ new ArrayBuffer(10);
			const view = new DataView(buffer);
			view.setUint8(0, MessageType.Resize);
			view.setInt32(1, width);
			view.setInt32(5, height);
			view.setUint8(9, this.sharp ? 1 : 0);
			this.send?.(buffer);
		}
		onStatus(next) {
			const soundBefore = this.soundState;
			this.status = next;
			if (this.canvas.width !== next.width || this.canvas.height !== next.height) {
				this.canvas.width = next.width;
				this.canvas.height = next.height;
			}
			if (!next.usable) this.releaseHeldKeys();
			this.events.onStatus?.(next);
			if (this.soundState !== soundBefore) this.events.onSound?.(this.soundState);
		}
		/** Opens the sound output, then asks the phone for its sound. Tried again on each click until the browser allows it. */
		async enableSound() {
			const running = await this.audio.start();
			if (this.soundWanted && running) this.sendIfAuthenticated(new Uint8Array([MessageType.AudioControl, 1]));
			this.events.onSound?.(this.soundState);
		}
		/** Browsers allow sound only from inside a click or key press. */
		allowSound() {
			if (this.soundWanted && !this.audio.isRunning) this.enableSound();
		}
		onAudio(view) {
			this.audio.play(view, 9);
			const arrivalUs = nowUs();
			const captureUs = Number(view.getBigInt64(1));
			const stalls = this.audioStalls;
			const lateUs = arrivalUs - stalls.lastArrivalUs - (captureUs - stalls.lastCaptureUs);
			if (captureUs - stalls.lastCaptureUs < STALL_US && lateUs > STALL_US) {
				stalls.count++;
				stalls.worstMs = Math.max(stalls.worstMs, Math.round(lateUs / 1e3));
			}
			stalls.lastCaptureUs = captureUs;
			stalls.lastArrivalUs = arrivalUs;
			if (this.clockOffsetUs !== null) {
				this.audioTransitUs.push(arrivalUs - (captureUs - this.clockOffsetUs));
				if (this.audioTransitUs.length > MAX_AUDIO_SAMPLES) this.audioTransitUs.shift();
			}
		}
		/** How the sound is doing, for tools/measure.ts. */
		audioReport() {
			const delay = this.audio.outputDelay;
			return {
				state: this.soundState,
				transitMs: percentiles(this.audioTransitUs),
				outputDelayMs: delay === null ? null : Math.round(delay * 1e3),
				stalls: this.audioStalls.count,
				worstStallMs: this.audioStalls.worstMs,
				...this.audio.counts
			};
		}
		copyPhoneClipboard() {
			const text = this.phoneClipboard;
			if (text === null || !navigator.clipboard || !document.hasFocus()) return;
			this.phoneClipboard = null;
			navigator.clipboard.writeText(text).catch((error) => {
				console.info("couldn't copy the phone's clipboard here", error);
				this.phoneClipboard ??= text;
			});
		}
		/** Puts text on the phone's clipboard, and pastes it there if asked. */
		sendClipboard(text, paste) {
			const bytes = new TextEncoder().encode(text);
			if (bytes.length === 0 || bytes.length > 1e6) return false;
			const message = new Uint8Array(2 + bytes.length);
			message[0] = MessageType.SetClipboard;
			message[1] = paste ? 1 : 0;
			message.set(bytes, 2);
			this.sendIfAuthenticated(message);
			return true;
		}
		/** Ctrl+V, so the phone pastes what it already has. */
		sendPasteKeys() {
			const v = keycodeFor("KeyV");
			this.sendKey(0, v, META_CTRL);
			this.sendKey(1, v, META_CTRL);
		}
		ping() {
			const buffer = /* @__PURE__ */ new ArrayBuffer(9);
			const view = new DataView(buffer);
			view.setUint8(0, MessageType.Ping);
			view.setFloat64(1, nowUs());
			this.sendIfAuthenticated(buffer);
		}
		onPong(view) {
			const sentUs = view.getFloat64(1);
			const serverUs = Number(view.getBigInt64(9));
			const receivedUs = nowUs();
			this.clockSamples.push({
				rtt: receivedUs - sentUs,
				offset: serverUs - (sentUs + receivedUs) / 2
			});
			if (this.clockSamples.length > CLOCK_SAMPLES) this.clockSamples.shift();
			const offset = this.clockSamples.reduce((best, sample) => sample.rtt < best.rtt ? sample : best).offset;
			if (this.clockOffsetUs !== null && Math.abs(offset - this.clockOffsetUs) > CLOCK_JUMP_US) this.audioTransitUs.length = 0;
			this.clockOffsetUs = offset;
		}
		createDecoder() {
			if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
			this.decoder = new VideoDecoder({
				output: (frame) => this.onDecoded(frame),
				error: (error) => this.onDecodeError(error)
			});
			this.decoder.configure({
				codec: this.codecString,
				optimizeForLatency: true,
				hardwareAcceleration: "prefer-hardware"
			});
			this.frameTimes.clear();
			this.waitingForKey = true;
		}
		onDecodeError(error) {
			console.warn("decoder error", error);
			this.requestKeyFrame();
			this.createDecoder();
		}
		requestKeyFrame() {
			this.sendIfAuthenticated(new Uint8Array([MessageType.KeyFrame]));
		}
		onVideo(view, buffer) {
			const flags = view.getUint8(1);
			const captureUs = Number(view.getBigInt64(2));
			const encodedUs = Number(view.getBigInt64(10));
			const sentUs = Number(view.getBigInt64(18));
			const data = new Uint8Array(buffer, 26);
			this.second.bytes += buffer.byteLength;
			this.measure.bytes += buffer.byteLength;
			if (flags & 1) {
				const changed = !this.configBytes || this.configBytes.length !== data.length || this.configBytes.some((byte, i) => byte !== data[i]);
				this.configBytes = data.slice();
				this.codecString = codecFromConfig(this.configBytes);
				if (changed || !this.decoder || this.decoder.state === "closed") this.createDecoder();
				return;
			}
			if (this.decoder?.state !== "configured") return;
			const key = (flags & 2) !== 0;
			if (this.waitingForKey && !key) return;
			if (this.decoder.decodeQueueSize > MAX_DECODE_QUEUE) {
				this.waitingForKey = true;
				this.requestKeyFrame();
				return;
			}
			this.waitingForKey = false;
			let payload = data;
			if (key && this.configBytes) {
				payload = new Uint8Array(this.configBytes.length + data.length);
				payload.set(this.configBytes);
				payload.set(data, this.configBytes.length);
			}
			this.frameTimes.set(captureUs, {
				encodedUs,
				sentUs,
				receivedUs: nowUs()
			});
			if (this.frameTimes.size > MAX_TRACKED_FRAMES) this.frameTimes.clear();
			this.decoder.decode(new EncodedVideoChunk({
				type: key ? "key" : "delta",
				timestamp: captureUs,
				data: payload
			}));
		}
		onDecoded(frame) {
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
				if (this.measure.active) this.measure.record(frame.timestamp, times, decodedUs, latency, this.clockOffsetUs);
			}
			if (this.measure.active) this.measure.probe(frame, decodedUs);
			frame.close();
		}
		reportStats() {
			const { frames, bytes, latencyTotal, latencyCount } = this.second;
			this.events.onStats?.({
				fps: frames,
				megabits: bytes * 8 / 1e6,
				latencyMs: latencyCount > 0 ? latencyTotal / latencyCount / 1e3 : null
			});
			this.second.frames = 0;
			this.second.bytes = 0;
			this.second.latencyTotal = 0;
			this.second.latencyCount = 0;
		}
		toDisplay(event) {
			const { canvas } = this;
			const box = canvas.getBoundingClientRect();
			const scale = Math.min(box.width / canvas.width, box.height / canvas.height);
			const left = box.left + (box.width - canvas.width * scale) / 2;
			const top = box.top + (box.height - canvas.height * scale) / 2;
			return [Math.round((event.clientX - left) / scale), Math.round((event.clientY - top) / scale)];
		}
		sendMouse(action, button, x, y) {
			const buffer = /* @__PURE__ */ new ArrayBuffer(11);
			const view = new DataView(buffer);
			view.setUint8(0, MessageType.Mouse);
			view.setUint8(1, action);
			view.setUint8(2, button);
			view.setInt32(3, x);
			view.setInt32(7, y);
			this.sendIfAuthenticated(buffer);
		}
		sendScroll(x, y, horizontal, vertical) {
			const buffer = /* @__PURE__ */ new ArrayBuffer(17);
			const view = new DataView(buffer);
			view.setUint8(0, MessageType.Scroll);
			view.setInt32(1, x);
			view.setInt32(5, y);
			view.setFloat32(9, horizontal);
			view.setFloat32(13, vertical);
			this.sendIfAuthenticated(buffer);
		}
		sendKey(action, code, meta) {
			const buffer = /* @__PURE__ */ new ArrayBuffer(10);
			const view = new DataView(buffer);
			view.setUint8(0, MessageType.Key);
			view.setUint8(1, action);
			view.setInt32(2, code);
			view.setInt32(6, meta);
			this.sendIfAuthenticated(buffer);
		}
		/** Sends the pointer's latest position now, or as soon as the last move is MOVE_INTERVAL_MS old. */
		queueMove() {
			this.pendingMove = true;
			const wait = MOVE_INTERVAL_MS - (performance.now() - this.lastMoveAt);
			if (wait <= 0) this.flushMove();
			else if (this.moveTimer === void 0) this.moveTimer = setTimeout(() => this.flushMove(), wait);
		}
		/** Sends a waiting move, so that a press or scroll after it lands where the pointer really is. */
		flushMove() {
			clearTimeout(this.moveTimer);
			this.moveTimer = void 0;
			if (!this.pendingMove) return;
			this.pendingMove = false;
			this.lastMoveAt = performance.now();
			this.sendMouse(0, 0, this.pointerAt[0], this.pointerAt[1]);
		}
		releaseHeldKeys() {
			for (const code of this.heldKeys) this.sendKey(1, code, 0);
			this.heldKeys.clear();
		}
		syncButtons(buttons) {
			this.flushMove();
			const [x, y] = this.pointerAt;
			for (const bit of MOUSE_BUTTON_BITS) if ((this.heldButtons ^ buttons) & bit) this.sendMouse(buttons & bit ? 1 : 2, bit, x, y);
			this.heldButtons = buttons;
		}
		releaseHeldButtons() {
			this.syncButtons(0);
		}
		listenForInput() {
			const { canvas } = this;
			const { signal } = this.listeners;
			const moveEvent = "onpointerrawupdate" in window ? "pointerrawupdate" : "pointermove";
			canvas.addEventListener(moveEvent, (event) => {
				this.pointerAt = this.toDisplay(event);
				this.queueMove();
			}, { signal });
			canvas.addEventListener("pointermove", (event) => {
				if (event.button !== -1) {
					this.pointerAt = this.toDisplay(event);
					this.syncButtons(event.buttons);
				}
			}, { signal });
			canvas.addEventListener("pointerdown", (event) => {
				event.preventDefault();
				canvas.focus();
				this.allowSound();
				this.pointerAt = this.toDisplay(event);
				this.syncButtons(event.buttons);
				canvas.setPointerCapture(event.pointerId);
			}, { signal });
			canvas.addEventListener("pointerup", (event) => {
				event.preventDefault();
				this.pointerAt = this.toDisplay(event);
				this.syncButtons(event.buttons);
			}, { signal });
			canvas.addEventListener("pointercancel", () => this.releaseHeldButtons(), { signal });
			canvas.addEventListener("lostpointercapture", () => this.releaseHeldButtons(), { signal });
			canvas.addEventListener("contextmenu", (event) => event.preventDefault(), { signal });
			canvas.addEventListener("wheel", (event) => {
				event.preventDefault();
				this.flushMove();
				const [x, y] = this.toDisplay(event);
				const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 3 : 100;
				this.sendScroll(x, y, event.deltaX / unit, -event.deltaY / unit);
			}, {
				passive: false,
				signal
			});
			window.addEventListener("keydown", (event) => {
				const code = keycodeFor(event.code);
				if (code === void 0 || !this.authenticated) return;
				this.allowSound();
				if (isPasteShortcut(event) && this.status?.clipboard && !isEditable(event.target)) {
					clearTimeout(this.pasteTimer);
					this.pasteTimer = setTimeout(() => {
						this.pasteTimer = void 0;
						this.sendPasteKeys();
					}, PASTE_WAIT_MS);
					return;
				}
				event.preventDefault();
				this.heldKeys.add(code);
				this.sendKey(0, code, metaState(event));
			}, { signal });
			window.addEventListener("keyup", (event) => {
				const code = keycodeFor(event.code);
				if (code === void 0 || !this.heldKeys.has(code)) return;
				event.preventDefault();
				this.heldKeys.delete(code);
				this.sendKey(1, code, metaState(event));
			}, { signal });
			window.addEventListener("paste", (event) => {
				if (!this.authenticated || isEditable(event.target)) return;
				event.preventDefault();
				clearTimeout(this.pasteTimer);
				this.pasteTimer = void 0;
				if (!this.status?.clipboard || !this.sendClipboard(event.clipboardData?.getData("text/plain") ?? "", true)) this.sendPasteKeys();
			}, { signal });
			window.addEventListener("focus", () => this.copyPhoneClipboard(), { signal });
			window.addEventListener("blur", () => {
				this.releaseHeldKeys();
				this.releaseHeldButtons();
			}, { signal });
		}
		click(x, y) {
			this.sendMouse(0, 0, x, y);
			this.sendMouse(1, 1, x, y);
			this.sendMouse(2, 1, x, y);
		}
		/** Time from sending a click to the first decoded frame that looks different. */
		async measureClicks({ targets, count = 30, settleMs = 900, timeoutMs = 2e3 }) {
			this.measure.start();
			const samples = [];
			let missed = 0;
			for (let i = 0; i < count; i++) {
				await sleep(settleMs);
				const [x, y] = targets[i % targets.length];
				const sentUs = nowUs();
				const change = this.measure.waitForChange(timeoutMs);
				this.click(x, y);
				const changedUs = await change;
				if (changedUs === null) missed++;
				else samples.push(changedUs - sentUs);
			}
			this.measure.active = false;
			return {
				clickToChange: percentiles(samples),
				missed
			};
		}
		/**
		* Time from moving the pointer to the first decoded frame that looks different: how far the phone's own cursor
		* trails the mouse. Only hovers, so nothing on the phone is clicked.
		*/
		async measureHover({ start, count = 40, step = 80, settleMs = 350, timeoutMs = 1e3 }) {
			this.measure.start();
			const samples = [];
			let missed = 0;
			const [x0, y0] = start;
			this.sendMouse(0, 0, x0, y0);
			for (let i = 0; i < count; i++) {
				await sleep(settleMs);
				const x = x0 + (i % 2 === 0 ? step : 0);
				const sentUs = nowUs();
				const change = this.measure.waitForChange(timeoutMs);
				this.sendMouse(0, 0, x, y0);
				const changedUs = await change;
				if (changedUs === null) missed++;
				else samples.push(changedUs - sentUs);
			}
			this.measure.active = false;
			return {
				moveToChange: percentiles(samples),
				missed,
				latencyMs: this.measure.summary()
			};
		}
		/** Drags a window in a circle, which makes the desktop redraw constantly. */
		async measureDrag({ seconds, start, radius = 150 }) {
			this.measure.start();
			const [cx, cy] = start;
			this.sendMouse(0, 0, cx, cy);
			this.sendMouse(1, 1, cx, cy);
			const startedAt = performance.now();
			const end = startedAt + seconds * 1e3;
			while (performance.now() < end) {
				const angle = (performance.now() - startedAt) / 1e3 * 2;
				this.sendMouse(0, 0, Math.round(cx + radius * (Math.cos(angle) - 1)), Math.round(cy + radius * Math.sin(angle)));
				await sleep(16);
			}
			this.sendMouse(0, 0, cx, cy);
			this.sendMouse(2, 1, cx, cy);
			const elapsed = (performance.now() - startedAt) / 1e3;
			this.measure.active = false;
			return {
				seconds: Math.round(elapsed),
				decodedFps: Math.round(this.measure.frames / elapsed * 10) / 10,
				distinctFps: Math.round(this.measure.distinct / elapsed * 10) / 10,
				megabitsPerSecond: Math.round(this.measure.bytes * 8 / elapsed / 1e5) / 10,
				droppedFrames: this.status ? this.status.dropped : null,
				latencyMs: this.measure.summary()
			};
		}
	};
	function isEditable(target) {
		return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLElement && target.isContentEditable;
	}
	/** Goes fullscreen, or back. Lets Esc and browser shortcuts reach the phone, where the browser allows it. */
	async function toggleFullscreen(canvas) {
		if (document.fullscreenElement) {
			await document.exitFullscreen();
			return;
		}
		await document.documentElement.requestFullscreen();
		await navigator.keyboard?.lock?.();
		canvas.focus();
	}
	// src/phone-page/main.ts
	var RECONNECT_MS = 1e3;
	var STORAGE_KEY = "shinonome-pairing-code";
	/** "off" keeps the phone's sound on the phone. */
	var SOUND_KEY = "shinonome-sound";
	/** "on" gives the desktop the phone's density. */
	var SHARP_KEY = "shinonome-sharp";
	var SOUND_LABELS = {
		off: "Sound: phone",
		"needs-click": "Sound: click to allow",
		starting: "Sound: here",
		on: "Sound: here",
		failed: "Sound: unavailable"
	};
	function byId(id) {
		return document.getElementById(id);
	}
	var canvas = byId("screen");
	var pairForm = byId("pair");
	var codeInput = byId("code");
	var pairError = byId("pair-error");
	var notice = byId("notice");
	var hud = byId("hud");
	var soundButton = byId("sound");
	var sharpButton = byId("sharp");
	var pendingChallenge = null;
	var sessionEnded = false;
	function readStored(key) {
		try {
			return localStorage.getItem(key);
		} catch {
			return null;
		}
	}
	function writeStored(key, value) {
		try {
			if (value) localStorage.setItem(key, value);
			else localStorage.removeItem(key);
		} catch {}
	}
	function readCode() {
		return readStored(STORAGE_KEY);
	}
	function writeCode(code) {
		writeStored(STORAGE_KEY, code);
	}
	function normalizeCode(raw) {
		return raw.toUpperCase().replace(/[^0-9A-Z]/g, "");
	}
	function showNotice(text) {
		notice.textContent = text;
		notice.hidden = !text;
	}
	function showPairForm(error) {
		pairError.textContent = error ?? "";
		pairForm.hidden = false;
		codeInput.focus();
	}
	async function answerChallenge(code) {
		const nonce = pendingChallenge;
		if (!nonce) return;
		pendingChallenge = null;
		const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(code), {
			name: "HMAC",
			hash: "SHA-256"
		}, false, ["sign"]);
		const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, nonce));
		writeCode(code);
		session.answerChallenge(signature);
	}
	var session = new DesktopSession(canvas, {
		onChallenge(nonce) {
			pendingChallenge = nonce;
			const code = readCode();
			if (code) answerChallenge(code);
			else showPairForm();
		},
		onAuthenticated() {
			pairForm.hidden = true;
			showNotice("");
		},
		onAuthFailed(lockedOut) {
			writeCode(null);
			showPairForm(lockedOut ? "Too many wrong codes. Wait 30 seconds and try again." : "That code is wrong. Check the code your phone shows.");
		},
		onReplaced() {
			sessionEnded = true;
			showNotice("This session is now open in another window. Reload this page to use it here.");
		},
		onStatus(status) {
			if (!status.desktop) showNotice("This phone did not make the display a desktop, so windows may not behave as expected.");
			else showNotice(status.usable ? "" : "Your phone is locked. Unlock it to continue.");
		},
		onSound(state) {
			soundButton.textContent = SOUND_LABELS[state];
			soundButton.setAttribute("aria-pressed", String(state === "on" || state === "starting"));
		},
		onStats({ fps, megabits, latencyMs }) {
			const latency = latencyMs === null ? "–" : `${latencyMs.toFixed(0)} ms`;
			hud.textContent = `${fps} fps · ${megabits.toFixed(1)} Mbit/s · ${latency}`;
		}
	});
	function connect() {
		if (sessionEnded) return;
		const socket = new WebSocket(`wss://${location.host}/ws`);
		socket.binaryType = "arraybuffer";
		socket.onmessage = (event) => session.receive(event.data);
		socket.onclose = onClose;
		session.attach((data) => {
			if (socket.readyState === WebSocket.OPEN) socket.send(data);
		});
	}
	function onClose() {
		session.detach();
		if (sessionEnded) return;
		if (pairForm.hidden) showNotice("Connection lost. Reconnecting…");
		setTimeout(connect, RECONNECT_MS);
	}
	pairForm.addEventListener("submit", (event) => {
		event.preventDefault();
		const code = normalizeCode(codeInput.value);
		if (!code || !pendingChallenge) return;
		pairForm.hidden = true;
		answerChallenge(code);
	});
	byId("fullscreen").addEventListener("click", () => void toggleFullscreen(canvas));
	soundButton.addEventListener("click", () => {
		const state = session.soundState;
		const on = state === "off" || state === "needs-click";
		writeStored(SOUND_KEY, on ? null : "off");
		session.setSound(on);
	});
	session.setSound(readStored(SOUND_KEY) !== "off");
	function showSharp(on) {
		sharpButton.textContent = on ? "Sharp: on" : "Sharp: off";
		sharpButton.setAttribute("aria-pressed", String(on));
	}
	sharpButton.addEventListener("click", () => {
		const on = readStored(SHARP_KEY) !== "on";
		writeStored(SHARP_KEY, on ? "on" : null);
		showSharp(on);
		session.setSharp(on);
	});
	showSharp(readStored(SHARP_KEY) === "on");
	session.setSharp(readStored(SHARP_KEY) === "on");
	byId("end").addEventListener("click", () => {
		sessionEnded = true;
		session.stop();
		showNotice("Session ended. You can close this window.");
	});
	exposeDebugApi(() => session);
	function start() {
		if (!window.isSecureContext || !window.VideoDecoder) {
			showNotice("This browser cannot decode the video here. Use a current version of Chrome, Edge, Safari or Firefox over https.");
			return;
		}
		const fragment = new URLSearchParams(location.hash.slice(1)).get("code");
		if (fragment) {
			writeCode(normalizeCode(fragment));
			history.replaceState(null, "", location.pathname);
		}
		connect();
	}
	start();
})();
