// Drives a real browser against the phone and reports what it measured. Needs a debug build of the
// app, which contains the test window that this clicks and drags, and a session already running.
//
//   pnpm measure --serial 192.168.1.50:40000 --host 192.168.1.50 --drag 30 --clicks 30
//
// The client gets its own throwaway profile, and is told to accept the phone's self-signed
// certificate unless --real-certificate is set.
//
// To test the USB site instead, serve its build (pnpm preview, in web), stop adb (adb kill-server) and
// name the page:
//
//   pnpm measure --usb http://localhost:4173/ --profile /tmp/shinonome-usb --drag 30 --clicks 30
//
// This starts its own session and needs no --serial or --host. Pick the phone if the browser asks, and
// allow USB debugging on the phone if it asks. Keep the same --profile and neither asks again.
//
// With pnpm dev, --dev-serial reaches the phone through the adb server instead, so adb keeps running and
// nothing needs a click. On a PIN-locked phone, pass --server-args=--screen-on so ending the session doesn't
// lock it. --features checks sound, paste, copying back and a dropped file in the test window:
//
//   pnpm measure --usb http://localhost:5173/ --dev-serial SERIAL --server-args=--screen-on --features
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
	options: {
		serial: { type: "string" },
		host: { type: "string" },
		// The address of the USB site. Everything goes through that page, including commands for the phone.
		usb: { type: "string" },
		// With pnpm dev, connect to this serial through the adb server instead of over WebUSB, so adb keeps running.
		"dev-serial": { type: "string" },
		// A browser profile to keep, because the USB site's permissions and adb key live in it.
		profile: { type: "string" },
		// The browser's debugging port, if something else on this computer is already using the usual one.
		"debug-port": { type: "string", default: "9333" },
		// Press End session when finished, and report what the phone did.
		"end-session": { type: "boolean", default: false },
		// The test window to open, for a debug build installed under another package name.
		"test-window": { type: "string", default: "com.wonderhoylabs.shinonome/.TestWindowActivity" },
		port: { type: "string", default: "27183" },
		drag: { type: "string", default: "30" },
		clicks: { type: "string", default: "30" },
		rounds: { type: "string", default: "1" },
		screenshot: { type: "string" },
		out: { type: "string" },
		browser: { type: "string", default: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
		"open-settings": { type: "boolean", default: true },
		"no-open-settings": { type: "boolean", default: false },
		"wait-unlock": { type: "string", default: "0" },
		// Go through the browser's certificate warning like a real user, instead of skipping it.
		"real-certificate": { type: "boolean", default: false },
		// Only report whether the client can run, which works on a locked phone.
		probe: { type: "boolean", default: false },
		// Send real mouse, wheel and key events to the page and save a screenshot after each.
		"exercise-input": { type: "string" },
		"close-test-window": { type: "boolean", default: false },
		// Move the pointer back and forth this many times, and time how long the phone's cursor takes to follow.
		hover: { type: "string", default: "0" },
		// Extra options for the server when the USB site starts it, such as --screen-on. Needs the development server.
		"server-args": { type: "string" },
		// Drag the test window with real mouse events paced like a person, and report whether it moved.
		"real-drag": { type: "boolean", default: false },
		// Check sound, paste, copying from the phone and dropping a file, in the test window. Never reads or sends
		// this computer's own clipboard.
		features: { type: "boolean", default: false },
		// Turn on sharp mode, which gives the desktop the phone's density, before connecting.
		sharp: { type: "boolean", default: false },
	},
});

const DEBUG_PORT = Number(args["debug-port"]);
const TITLE_BAR_Y = 24;
const TEXT_BOX_Y = 90;
const PRESS_TARGET_Y = 300;
const HOVER_STEPS = 10;
const DRAG_STEPS = 40;
const MOVE_INTERVAL_MS = 16;
const HOVER_PAUSE_MS = 400;
const PRESS_PAUSE_MS = 150;
const RELEASE_SETTLE_MS = 1000;
const REAL_DRAG_X = 120;
const REAL_DRAG_Y = 80;
const REAL_DRAG_ROUNDS = 3;
const REAL_DRAG_FLIP_TOP = 300;
const USB_CONNECT_TIMEOUT_MS = 120000;
const END_SESSION_WAIT_MS = 3000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Point = [number, number];

interface Bounds {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

/** What the page's window.shinonome.getStatus() reports. */
interface Status {
	usable: boolean;
	displayId: number;
	width: number;
	height: number;
}

interface Vitals {
	at: string;
	batteryPercent: number;
	batteryCelsius: number;
	charging: boolean;
	thermalStatus: number;
}

let usbPage: Page | null = null;

async function adb(...command: string[]): Promise<string> {
	if (usbPage) {
		// The page holds USB, so it's the only way in. Every command here starts with 'shell'.
		const line = JSON.stringify(command.slice(1).join(" "));
		return (await usbPage.evaluate<string>(`window.shinonome.shell(${line})`)).trim();
	}
	return execFileSync("adb", ["-s", args.serial ?? "", ...command], { encoding: "utf8" }).trim();
}

// Reads the test window's live bounds, because `am stack list` can report old ones.
let lastWindow: Bounds | null = null;

async function testWindow(): Promise<Bounds> {
	const tasks = (await adb("shell", "dumpsys", "activity", "activities")).split(/\n(?=\s*\* Task\{)/);
	// By activity, because the app's main screen can be visible on the phone as well.
	const task = tasks.find((t) => t.includes("TestWindowActivity") && t.includes(" visible=true"));
	const match = task && /mBounds=Rect\((-?\d+), (-?\d+) - (-?\d+), (-?\d+)\)/.exec(task);
	if (match) {
		const [left, top, right, bottom] = match.slice(1).map(Number) as [number, number, number, number];
		lastWindow = { left, top, right, bottom };
	}
	if (!lastWindow) {
		throw new Error("No visible test window to measure with");
	}
	return lastWindow;
}

async function phoneVitals(): Promise<Vitals> {
	const battery = await adb("shell", "dumpsys battery");
	const thermal = await adb("shell", "dumpsys thermalservice");
	const field = (name: string) => battery.match(new RegExp(`${name}: (.+)`))?.[1];
	return {
		at: new Date().toISOString(),
		batteryPercent: Number(field("level")),
		batteryCelsius: Number(field("temperature")) / 10,
		charging: field("AC powered") === "true" || field("USB powered") === "true",
		thermalStatus: Number(thermal.match(/Thermal Status: (\d+)/)?.[1]),
	};
}

/** One page in the browser, driven over the Chrome DevTools Protocol. */
class Page {
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

	private readonly socket: WebSocket;

	constructor(socket: WebSocket) {
		this.socket = socket;
		socket.addEventListener("message", (event) => {
			const message = JSON.parse(String(event.data)) as {
				id: number;
				result?: unknown;
				error?: { message: string };
			};
			const entry = this.pending.get(message.id);
			if (!entry) return;
			this.pending.delete(message.id);
			if (message.error) entry.reject(new Error(message.error.message));
			else entry.resolve(message.result);
		});
	}

	static async open(browserPort: number): Promise<Page> {
		let targets: { type: string; webSocketDebuggerUrl: string } | undefined;
		for (let i = 0; i < 40 && !targets; i++) {
			try {
				const response = await fetch(`http://127.0.0.1:${browserPort}/json/list`);
				const list = (await response.json()) as { type: string; webSocketDebuggerUrl: string }[];
				const page = list.find((t) => t.type === "page");
				if (page) {
					targets = page;
				}
			} catch {
				await sleep(250);
			}
		}
		if (!targets) {
			throw new Error("The browser did not expose a page to debug");
		}
		const socket = new WebSocket(targets.webSocketDebuggerUrl);
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve(), { once: true });
			socket.addEventListener("error", reject, { once: true });
		});
		return new Page(socket);
	}

	send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
		const id = this.nextId++;
		this.socket.send(JSON.stringify({ id, method, params }));
		return new Promise<T>((resolve, reject) =>
			this.pending.set(id, { resolve: (value) => resolve(value as T), reject }),
		);
	}

	async evaluate<T = unknown>(expression: string): Promise<T> {
		const { result, exceptionDetails } = await this.send<{
			result: { value: T };
			exceptionDetails?: { text: string; exception?: { description?: string } };
		}>("Runtime.evaluate", {
			expression,
			awaitPromise: true,
			returnByValue: true,
		});
		if (exceptionDetails) {
			throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
		}
		return result.value;
	}

	async waitFor(expression: string, timeoutMs: number, what: string): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (await this.evaluate(expression).catch(() => false)) {
				return;
			}
			await sleep(250);
		}
		throw new Error(`Timed out waiting for ${what}`);
	}
}

// Moves through a browser's certificate warning the way a person would.
async function clickThroughWarning(page: Page) {
	await sleep(2500);
	const clicked = await page.evaluate<boolean>(`(() => {
    const details = document.getElementById('details-button');
    const proceed = document.getElementById('proceed-link');
    if (!details || !proceed) return false;
    details.click();
    proceed.click();
    return true;
  })()`);
	console.info("certificate warning shown:", clicked);
	await sleep(2500);
}

async function sendMouse(page: Page, type: string, x: number, y: number, extra: Record<string, unknown> = {}) {
	await page.send("Input.dispatchMouseEvent", { type, x, y, ...extra });
}

async function sendKey(page: Page, code: string, key: string, keyCode: number) {
	await page.send("Input.dispatchKeyEvent", { type: "keyDown", code, key, windowsVirtualKeyCode: keyCode });
	await page.send("Input.dispatchKeyEvent", { type: "keyUp", code, key, windowsVirtualKeyCode: keyCode });
}

// Maps a point on the desktop to where it sits in the browser window.
async function desktopToClient(page: Page): Promise<(point: Point) => Point> {
	const toClient = await page.evaluate<{ scale: number; left: number; top: number }>(`(() => {
    const canvas = document.getElementById('screen');
    const box = canvas.getBoundingClientRect();
    const scale = Math.min(box.width / canvas.width, box.height / canvas.height);
    return {
      scale,
      left: box.left + (box.width - canvas.width * scale) / 2,
      top: box.top + (box.height - canvas.height * scale) / 2,
    };
  })()`);
	return ([x, y]) => [toClient.left + x * toClient.scale, toClient.top + y * toClient.scale];
}

// Hovers, pauses, presses, moves slowly and releases, the way a person drags a window. This goes
// through the page's own handlers, which measureDrag skips, and checks the window's live bounds.
async function realDrag(page: Page) {
	const at = await desktopToClient(page);
	const before = await testWindow();
	const start: Point = [Math.round((before.left + before.right) / 2), before.top + TITLE_BAR_Y];
	const point = (i: number, steps: number, dx: number, dy: number) =>
		at([start[0] + (dx * i) / steps, start[1] + (dy * i) / steps]);
	// Heads back up from the lower half of the screen, so repeated runs keep the title bar on it.
	const direction = before.top > REAL_DRAG_FLIP_TOP ? -1 : 1;
	const wanted: Point = [REAL_DRAG_X * direction, REAL_DRAG_Y * direction];

	for (let i = HOVER_STEPS; i >= 0; i--) {
		await sendMouse(page, "mouseMoved", ...point(i, HOVER_STEPS, 60, 60));
		await sleep(MOVE_INTERVAL_MS);
	}
	await sleep(HOVER_PAUSE_MS);
	await sendMouse(page, "mousePressed", ...at(start), { button: "left", buttons: 1, clickCount: 1 });
	await sleep(PRESS_PAUSE_MS);
	for (let i = 1; i <= DRAG_STEPS; i++) {
		await sendMouse(page, "mouseMoved", ...point(i, DRAG_STEPS, ...wanted), { button: "left", buttons: 1 });
		await sleep(MOVE_INTERVAL_MS);
	}
	await sleep(PRESS_PAUSE_MS);
	const midway = await testWindow();
	await sendMouse(page, "mouseReleased", ...point(DRAG_STEPS, DRAG_STEPS, ...wanted), {
		button: "left",
		buttons: 0,
		clickCount: 1,
	});
	await sleep(RELEASE_SETTLE_MS);
	const after = await testWindow();
	return {
		before,
		midway,
		after,
		moved: [after.left - before.left, after.top - before.top],
		wanted,
	};
}

// Goes through the page's own event handlers, unlike measureClicks and measureDrag.
async function exerciseInput(page: Page, directory: string) {
	const at = await desktopToClient(page);
	const shot = async (name: string) => {
		await sleep(1800);
		const { data } = await page.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		writeFileSync(join(directory, `input-${name}.png`), Buffer.from(data, "base64"));
	};
	const click = async (point: Point, button = "left") => {
		const [x, y] = at(point);
		const mask = button === "left" ? 1 : 2;
		await sendMouse(page, "mouseMoved", x, y);
		await sendMouse(page, "mousePressed", x, y, { button, buttons: mask, clickCount: 1 });
		await sendMouse(page, "mouseReleased", x, y, { button, buttons: 0, clickCount: 1 });
	};

	const { left, top } = await testWindow();
	await click([left + 200, top + TEXT_BOX_Y]);
	for (const letter of "wifi") {
		await sendKey(page, `Key${letter.toUpperCase()}`, letter, letter.toUpperCase().charCodeAt(0));
	}
	await shot("1-typed");

	await click([left + 200, top + PRESS_TARGET_Y], "right");
	await shot("2-right-click");
}

const CMD = 4;
const FEATURE_WAIT_MS = 1500;

/** Presses a key with Cmd, as a Mac's shortcuts do. commands makes the browser run its own action, such as paste. */
async function sendShortcut(page: Page, letter: string, commands: string[] = []) {
	const code = `Key${letter.toUpperCase()}`;
	const keyCode = letter.toUpperCase().charCodeAt(0);
	await page.send("Input.dispatchKeyEvent", {
		type: "rawKeyDown",
		code,
		key: letter,
		windowsVirtualKeyCode: keyCode,
		modifiers: CMD,
		commands,
	});
	await page.send("Input.dispatchKeyEvent", {
		type: "keyUp",
		code,
		key: letter,
		windowsVirtualKeyCode: keyCode,
		modifiers: CMD,
	});
}

/** Sound, paste, the phone's clipboard and a dropped file, through the page's own handlers. */
async function exerciseFeatures(page: Page, displayId: number) {
	const report: Record<string, unknown> = {};
	// Writing to the clipboard needs focus, which a window in the background doesn't have.
	await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
	await adb("shell", "am", "force-stop", (args["test-window"] ?? "").split("/")[0] ?? "");
	await adb(
		"shell",
		"am",
		"start",
		"--display",
		String(displayId),
		"--ez",
		"tone",
		"true",
		"-n",
		args["test-window"] ?? "",
	);
	await sleep(4000);
	const at = await desktopToClient(page);
	const click = async (point: Point) => {
		const [x, y] = at(point);
		await sendMouse(page, "mouseMoved", x, y);
		await sendMouse(page, "mousePressed", x, y, { button: "left", buttons: 1, clickCount: 1 });
		await sendMouse(page, "mouseReleased", x, y, { button: "left", buttons: 0, clickCount: 1 });
	};
	const { left, top } = await testWindow();
	// A click first, because browsers only play sound after one.
	await click([left + 200, top + TEXT_BOX_Y]);
	await sleep(5000);
	report.sound = await page.evaluate("window.shinonome.audioReport()");

	// The browser should follow Cmd+V with a paste event. This one is stopped before the page sees it, so whatever
	// is on this computer's clipboard stays here, and the page's fallback sends plain Ctrl+V to the phone instead.
	await page.evaluate(`(() => {
    window.__pastes = 0;
    window.addEventListener("paste", (event) => {
      window.__pastes++;
      event.stopImmediatePropagation();
      event.preventDefault();
    }, { capture: true, once: true });
  })()`);
	await sendShortcut(page, "v", ["paste"]);
	await sleep(500);
	report.pasteEventFired = (await page.evaluate<number>("window.__pastes")) > 0;

	// A paste the page does see, made up here, twice, then copied back off the phone.
	await page.evaluate(`(() => {
    window.__copied = [];
    navigator.clipboard.writeText = (text) => { window.__copied.push(text); return Promise.resolve(); };
  })()`);
	await sendShortcut(page, "a");
	await sendKey(page, "Backspace", "Backspace", 8);
	await sleep(300);
	const word = `shinonome-${Date.now() % 100000}`;
	for (let i = 0; i < 2; i++) {
		await page.evaluate(`(() => {
      const data = new DataTransfer();
      data.setData("text/plain", ${JSON.stringify(word)});
      document.getElementById("screen").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
    })()`);
		await sleep(400);
	}
	await sendShortcut(page, "a");
	await sendShortcut(page, "c");
	await sleep(FEATURE_WAIT_MS);
	const copied = await page.evaluate<string[]>("window.__copied");
	report.clipboard = { pasted: word, copiedBack: copied, roundTrip: copied.includes(word + word) };

	// A file dropped on the desktop lands in Downloads.
	const directory = mkdtempSync(join(tmpdir(), "shinonome-drop-"));
	const name = `shinonome-drop-${Date.now() % 100000}.txt`;
	const path = join(directory, name);
	writeFileSync(path, "Dropped by tools/measure.ts\n");
	const [x, y] = at([left + 200, top + PRESS_TARGET_Y]);
	const data = { items: [], files: [path], dragOperationsMask: 1 };
	await page.send("Input.dispatchDragEvent", { type: "dragEnter", x, y, data });
	await page.send("Input.dispatchDragEvent", { type: "dragOver", x, y, data });
	await page.send("Input.dispatchDragEvent", { type: "drop", x, y, data });
	await sleep(3000);
	const listed = await adb("shell", "ls", "-l", `/sdcard/Download/${name}`).catch((error: Error) => error.message);
	report.drop = { name, bytes: statSync(path).size, onPhone: listed.trim() };
	await adb("shell", "rm", "-f", `/sdcard/Download/${name}`);
	rmSync(directory, { recursive: true, force: true });

	// And sound goes back to the phone.
	await clickById(page, "sound");
	await sleep(FEATURE_WAIT_MS);
	report.soundAfterToggle = await page.evaluate(
		"[window.shinonome.audioReport().state, window.shinonome.getStatus().audio]",
	);
	await clickById(page, "sound");
	await adb("shell", "am", "force-stop", (args["test-window"] ?? "").split("/")[0] ?? "");
	return report;
}

function launchBrowser(profile: string, url: string) {
	return spawn(
		args.browser ?? "",
		[
			`--user-data-dir=${profile}`,
			`--remote-debugging-port=${DEBUG_PORT}`,
			...(args["real-certificate"] ? [] : ["--ignore-certificate-errors"]),
			// The test window beeps, and the page still plays it, just not out loud.
			...(args.features ? ["--mute-audio"] : []),
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-background-timer-throttling",
			"--disable-renderer-backgrounding",
			"--disable-backgrounding-occluded-windows",
			"--window-size=1280,760",
			url,
		],
		{ stdio: "ignore" },
	);
}

// A real click, because a browser only shows its device chooser after one.
async function clickById(page: Page, id: string) {
	const [x, y] = await page.evaluate<Point>(`(() => {
    const box = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();
    return [box.left + box.width / 2, box.top + box.height / 2];
  })()`);
	await sendMouse(page, "mousePressed", x, y, { button: "left", buttons: 1, clickCount: 1 });
	await sendMouse(page, "mouseReleased", x, y, { button: "left", buttons: 0, clickCount: 1 });
}

// Goes through the onboarding like a person, skipping the app unless it's already there.
async function connectUsb(page: Page) {
	const connectId = args["dev-serial"] ? `dev-${args["dev-serial"]}` : "connect-phone";
	await page.waitFor(`document.getElementById(${JSON.stringify(connectId)}) !== null`, 15000, "the USB site to load");
	if (args["server-args"]) {
		await page.evaluate(
			`localStorage.setItem("shinonome.dev.server-args", ${JSON.stringify(args["server-args"])})`,
		);
	}
	await page.evaluate(
		args.sharp ? `localStorage.setItem("shinonome.sharp", "on")` : `localStorage.removeItem("shinonome.sharp")`,
	);
	await clickById(page, connectId);
	console.info("clicked Connect phone. Pick the phone or allow USB debugging if asked.");
	usbPage = page;
	const deadline = Date.now() + USB_CONNECT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const next = await page.evaluate<string>(`window.shinonome.isConnected() ? 'connected'
      : document.getElementById('skip-app') ? 'skip-app'
      : document.getElementById('start-for-me') ? 'start-for-me'
      : document.querySelector('.error-banner') ? 'failed: ' + document.querySelector('.error-banner').innerText
      : 'waiting'`);
		if (next === "connected") {
			return;
		}
		if (next.startsWith("failed")) {
			throw new Error(next);
		}
		if (next !== "waiting") {
			await clickById(page, next);
		}
		await sleep(500);
	}
	throw new Error("Timed out waiting for the USB connection");
}

async function main() {
	const url = args.usb || `https://${args.host}:${args.port}/`;
	const code = args.usb ? null : await adb("shell", "cat", "/data/local/tmp/shinonome/pairing-code");
	const profile = args.profile || mkdtempSync(join(tmpdir(), "shinonome-measure-"));
	const browser = launchBrowser(profile, url);

	const results: {
		url: string;
		status?: Status;
		vitalsBefore: Vitals | null;
		vitalsAfter: Vitals | null;
		realDrag?: unknown[];
		rounds: Record<string, unknown>[];
	} = { url, vitalsBefore: null, vitalsAfter: null, rounds: [] };
	try {
		const page = await Page.open(DEBUG_PORT);
		await page.send("Page.enable");
		await page.send("Runtime.enable");
		if (args["real-certificate"]) {
			await clickThroughWarning(page);
		}
		await page.waitFor('typeof window.shinonome === "object"', 15000, "the client page to load");
		if (args.usb) {
			await connectUsb(page);
		} else {
			await page.evaluate(
				`localStorage.setItem('shinonome-pairing-code', ${JSON.stringify(code)}); location.reload()`,
			);
			await sleep(1000);
			await page.waitFor(
				'typeof window.shinonome === "object" && window.shinonome.isConnected()',
				15000,
				"pairing to finish",
			);
		}
		await page.waitFor("window.shinonome.getStatus() !== null", 5000, "the first status message");

		let status = await page.evaluate<Status>("window.shinonome.getStatus()");
		results.status = status;
		console.info("connected:", JSON.stringify(status));
		if (args.probe) {
			console.info(
				"client:",
				JSON.stringify(
					await page.evaluate(`({
        secureContext: window.isSecureContext,
        videoDecoder: typeof VideoDecoder,
        address: location.href,
      })`),
				),
			);
			return;
		}
		const waitUnlockMs = Number(args["wait-unlock"]) * 1000;
		if (!status.usable && waitUnlockMs > 0) {
			console.info("phone is locked, waiting for it to be unlocked");
			await page.waitFor("window.shinonome.getStatus().usable", waitUnlockMs, "the phone to be unlocked");
			status = await page.evaluate<Status>("window.shinonome.getStatus()");
		}
		if (!status.usable) {
			throw new Error("The phone is locked, so the desktop session cannot start");
		}

		if (args["open-settings"] && !args["no-open-settings"]) {
			await sleep(2000);
			// Nothing important should sit behind the test window, in case a click goes astray.
			await adb("shell", "am", "force-stop", "com.android.settings");
			await adb("shell", "am", "start", "--display", String(status.displayId), "-n", args["test-window"] ?? "");
			await sleep(4000);
		}
		if (Number(args.hover) > 0) {
			const hover = await page.evaluate(
				`window.shinonome.measureHover(${JSON.stringify({
					start: [Math.round(status.width / 2), Math.round(status.height / 2)],
					count: Number(args.hover),
				})})`,
			);
			console.info("hover:", JSON.stringify(hover));
		}
		if (args["exercise-input"]) {
			await exerciseInput(page, args["exercise-input"]);
		}
		if (args.features) {
			console.info("features:", JSON.stringify(await exerciseFeatures(page, status.displayId)));
		}
		if (args["real-drag"]) {
			const rounds: Awaited<ReturnType<typeof realDrag>>[] = [];
			for (let i = 0; i < REAL_DRAG_ROUNDS; i++) {
				rounds.push(await realDrag(page));
			}
			results.realDrag = rounds;
			for (const round of rounds) {
				console.info("real drag:", JSON.stringify(round));
			}
		}
		results.vitalsBefore = await phoneVitals();

		const rounds = Number(args.rounds);
		for (let round = 0; round < rounds; round++) {
			const entry: Record<string, unknown> = { round, startedAt: new Date().toISOString() };
			if (Number(args.clicks) > 0) {
				const { left, top } = await testWindow();
				const target = [left + 200, top + PRESS_TARGET_Y];
				entry.clicks = await page.evaluate(
					`window.shinonome.measureClicks(${JSON.stringify({
						targets: [target],
						count: Number(args.clicks),
					})})`,
				);
			}
			if (Number(args.drag) > 0) {
				const { left, right, top } = await testWindow();
				entry.drag = await page.evaluate(
					`window.shinonome.measureDrag(${JSON.stringify({
						seconds: Number(args.drag),
						start: [Math.round((left + right) / 2), top + TITLE_BAR_Y],
					})})`,
				);
			}
			entry.vitals = await phoneVitals();
			results.rounds.push(entry);
			console.info(JSON.stringify(entry));
			if (args.out) {
				writeFileSync(args.out, JSON.stringify(results, null, 2));
			}
		}

		results.vitalsAfter = await phoneVitals();
		results.status = await page.evaluate<Status>("window.shinonome.getStatus()");
		if (args.screenshot) {
			const { data } = await page.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
			writeFileSync(args.screenshot, Buffer.from(data, "base64"));
		}
		if (args.out) {
			writeFileSync(args.out, JSON.stringify(results, null, 2));
		}
		console.info("summary:", JSON.stringify({ before: results.vitalsBefore, after: results.vitalsAfter }));
		if (args["close-test-window"]) {
			await adb("shell", "am", "force-stop", args["test-window"]?.split("/")[0] ?? "");
		}
		if (args["end-session"]) {
			await page.evaluate(`document.getElementById(${JSON.stringify(args.usb ? "end-session" : "end")}).click()`);
			await sleep(END_SESSION_WAIT_MS);
			const noticeSelector = args.usb ? ".notice-banner span" : "#notice";
			console.info(
				"after End session:",
				await page.evaluate(`document.querySelector(${JSON.stringify(noticeSelector)}).textContent`),
			);
		}
	} finally {
		browser.kill();
		await sleep(500);
		if (!args.profile) {
			rmSync(profile, { recursive: true, force: true });
		}
	}
}

main().catch((error) => {
	console.error("FAILED:", error.message);
	process.exit(1);
});
