// The page the phone serves over Wi-Fi: pairing, a WebSocket, and a small toolbar. This builds to
// android/app/src/main/assets/web/client.js with pnpm build:phone-page, so building the APK doesn't need Node.
import {
	DesktopSession,
	type DesktopStatus,
	exposeDebugApi,
	type SoundState,
	sharpSuggestion,
	toggleFullscreen,
} from "@wonderhoy-labs/shinonome";

const RECONNECT_MS = 1000;
const STORAGE_KEY = "shinonome-pairing-code";
/** "off" keeps the phone's sound on the phone. */
const SOUND_KEY = "shinonome-sound";
/** "on" gives the desktop the phone's density. */
const SHARP_KEY = "shinonome-sharp";
const SOUND_LABELS: Record<SoundState, string> = {
	off: "Sound: phone",
	"needs-click": "Sound: click to allow",
	starting: "Sound: here",
	on: "Sound: here",
	failed: "Sound: unavailable",
};

function byId<T extends HTMLElement>(id: string): T {
	return document.getElementById(id) as T;
}

const canvas = byId<HTMLCanvasElement>("screen");
const pairForm = byId<HTMLFormElement>("pair");
const codeInput = byId<HTMLInputElement>("code");
const pairError = byId("pair-error");
const notice = byId("notice");
const hud = byId("hud");
const soundButton = byId<HTMLButtonElement>("sound");
const sharpButton = byId<HTMLButtonElement>("sharp");
const sharpPrompt = byId("sharp-prompt");
const sharpPromptText = byId("sharp-prompt-text");

let pendingChallenge: Uint8Array<ArrayBuffer> | null = null;
let sessionEnded = false;
let lastStatus: DesktopStatus | null = null;
/** Apps someone said not now to sharp mode for. */
const sharpDeclined = new Set<string>();

function readStored(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function writeStored(key: string, value: string | null) {
	try {
		if (value) {
			localStorage.setItem(key, value);
		} else {
			localStorage.removeItem(key);
		}
	} catch {
		// Without storage it's simply asked for again next time.
	}
}

function readCode(): string | null {
	return readStored(STORAGE_KEY);
}

function writeCode(code: string | null) {
	writeStored(STORAGE_KEY, code);
}

function normalizeCode(raw: string): string {
	return raw.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

function showNotice(text: string) {
	notice.textContent = text;
	notice.hidden = !text;
}

function showPairForm(error?: string) {
	pairError.textContent = error ?? "";
	pairForm.hidden = false;
	codeInput.focus();
}

async function answerChallenge(code: string) {
	const nonce = pendingChallenge;
	if (!nonce) {
		return;
	}
	pendingChallenge = null;
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(code),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, nonce));
	writeCode(code);
	session.answerChallenge(signature);
}

const session = new DesktopSession(canvas, {
	onChallenge(nonce) {
		pendingChallenge = nonce;
		const code = readCode();
		if (code) {
			void answerChallenge(code);
		} else {
			showPairForm();
		}
	},
	onAuthenticated() {
		pairForm.hidden = true;
		showNotice("");
	},
	onAuthFailed(lockedOut) {
		writeCode(null);
		showPairForm(
			lockedOut
				? "Too many wrong codes. Wait 30 seconds and try again."
				: "That code is wrong. Check the code your phone shows.",
		);
	},
	// Two windows that both reconnected would keep throwing each other off, so the older one stays away.
	onReplaced() {
		sessionEnded = true;
		showNotice("This session is now open in another window. Reload this page to use it here.");
	},
	onStatus(status) {
		if (!status.desktop) {
			showNotice("This phone did not make the display a desktop, so windows may not behave as expected.");
		} else {
			showNotice(status.usable ? "" : "Your phone is locked. Unlock it to continue.");
		}
		lastStatus = status;
		showSharpPrompt();
	},
	onSound(state) {
		soundButton.textContent = SOUND_LABELS[state];
		soundButton.setAttribute("aria-pressed", String(state === "on" || state === "starting"));
	},
	onStats({ fps, megabits, latencyMs }) {
		const latency = latencyMs === null ? "–" : `${latencyMs.toFixed(0)} ms`;
		hud.textContent = `${fps} fps · ${megabits.toFixed(1)} Mbit/s · ${latency}`;
	},
});

function connect() {
	if (sessionEnded) {
		return;
	}
	const socket = new WebSocket(`wss://${location.host}/ws`);
	socket.binaryType = "arraybuffer";
	socket.onmessage = (event) => session.receive(event.data as ArrayBuffer);
	socket.onclose = onClose;
	session.attach((data) => {
		if (socket.readyState === WebSocket.OPEN) {
			socket.send(data);
		}
	});
}

function onClose() {
	session.detach();
	if (sessionEnded) {
		return;
	}
	if (pairForm.hidden) {
		showNotice("Connection lost. Reconnecting…");
	}
	setTimeout(connect, RECONNECT_MS);
}

pairForm.addEventListener("submit", (event) => {
	event.preventDefault();
	const code = normalizeCode(codeInput.value);
	if (!code || !pendingChallenge) {
		return;
	}
	pairForm.hidden = true;
	void answerChallenge(code);
});

byId("fullscreen").addEventListener("click", () => void toggleFullscreen(canvas));

soundButton.addEventListener("click", () => {
	const state = session.soundState;
	const on = state === "off" || state === "needs-click";
	writeStored(SOUND_KEY, on ? null : "off");
	session.setSound(on);
});
session.setSound(readStored(SOUND_KEY) !== "off");

function showSharp(on: boolean) {
	sharpButton.textContent = on ? "Sharp: on" : "Sharp: off";
	sharpButton.setAttribute("aria-pressed", String(on));
}

function setSharp(on: boolean) {
	writeStored(SHARP_KEY, on ? "on" : null);
	showSharp(on);
	session.setSharp(on);
	showSharpPrompt();
}

/** Offers sharp mode when the app in front on the desktop needs it. */
function showSharpPrompt() {
	const app = sharpSuggestion(lastStatus, readStored(SHARP_KEY) === "on", sharpDeclined);
	sharpPrompt.hidden = app === null;
	sharpPrompt.dataset.app = app ?? "";
	sharpPromptText.textContent = app
		? `${app} needs sharp mode to lay out properly. Turning it on restarts ${app}, and costs a little latency.`
		: "";
}

sharpButton.addEventListener("click", () => setSharp(readStored(SHARP_KEY) !== "on"));
byId("sharp-prompt-on").addEventListener("click", () => setSharp(true));
byId("sharp-prompt-later").addEventListener("click", () => {
	sharpDeclined.add(sharpPrompt.dataset.app ?? "");
	showSharpPrompt();
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
		showNotice(
			"This browser cannot decode the video here. Use a current version of Chrome, Edge, Safari or Firefox over https.",
		);
		return;
	}
	// A code in the URL fragment never reaches the network, which suits pairing links.
	const fragment = new URLSearchParams(location.hash.slice(1)).get("code");
	if (fragment) {
		writeCode(normalizeCode(fragment));
		history.replaceState(null, "", location.pathname);
	}
	connect();
}

start();
