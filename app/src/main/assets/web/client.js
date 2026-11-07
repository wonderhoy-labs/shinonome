// Generated from site/src/phone-page and site/src/session. Change those and run npm run build:phone-page.
(function() {
	// src/session/debug.ts
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
			...shell ? { shell } : {}
		};
	}
	// src/session/fit.ts
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
	// src/session/keyboard.ts
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
	// src/session/measure.ts
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
	// src/session/protocol.ts
	var MessageType = {
		Video: 1,
		Status: 2,
		Pong: 3,
		AuthChallenge: 4,
		AuthResult: 5,
		Replaced: 6,
		Mouse: 16,
		Scroll: 17,
		Key: 18,
		Ping: 19,
		Stop: 20,
		AuthResponse: 21,
		KeyFrame: 22,
		Resize: 23
	};
	// src/session/desktop-session.ts
	var PING_INTERVAL_MS = 2e3;
	var CLOCK_SAMPLES = 8;
	var MAX_DECODE_QUEUE = 6;
	var MAX_TRACKED_FRAMES = 240;
	var STATS_INTERVAL_MS = 1e3;
	var FIT_DELAY_MS = 400;
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
		/** A new connection to the phone is open. */
		attach(send) {
			this.send = send;
			this.authenticated = false;
		}
		/** That connection has gone. The server has already lifted everything it was holding. */
		detach() {
			clearInterval(this.pingTimer);
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
				case MessageType.Replaced: this.events.onReplaced?.();
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
			this.fitNow();
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
			if (this.status?.width === width && this.status.height === height) return;
			const buffer = /* @__PURE__ */ new ArrayBuffer(9);
			const view = new DataView(buffer);
			view.setUint8(0, MessageType.Resize);
			view.setInt32(1, width);
			view.setInt32(5, height);
			this.sendIfAuthenticated(buffer);
		}
		onStatus(next) {
			this.status = next;
			if (this.canvas.width !== next.width || this.canvas.height !== next.height) {
				this.canvas.width = next.width;
				this.canvas.height = next.height;
			}
			if (!next.usable) this.releaseHeldKeys();
			this.events.onStatus?.(next);
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
			this.clockOffsetUs = this.clockSamples.reduce((best, sample) => sample.rtt < best.rtt ? sample : best).offset;
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
			if (!this.decoder || this.decoder.state !== "configured") return;
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
		releaseHeldKeys() {
			for (const code of this.heldKeys) this.sendKey(1, code, 0);
			this.heldKeys.clear();
		}
		syncButtons(buttons) {
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
				this.sendMouse(0, 0, this.pointerAt[0], this.pointerAt[1]);
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
	function byId(id) {
		return document.getElementById(id);
	}
	var canvas = byId("screen");
	var pairForm = byId("pair");
	var codeInput = byId("code");
	var pairError = byId("pair-error");
	var notice = byId("notice");
	var hud = byId("hud");
	var pendingChallenge = null;
	var sessionEnded = false;
	function readCode() {
		try {
			return localStorage.getItem(STORAGE_KEY);
		} catch {
			return null;
		}
	}
	function writeCode(code) {
		try {
			if (code) localStorage.setItem(STORAGE_KEY, code);
			else localStorage.removeItem(STORAGE_KEY);
		} catch {}
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
