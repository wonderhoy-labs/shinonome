// The page the phone serves over Wi-Fi: pairing, a WebSocket, and a small toolbar. This builds to
// android/app/src/main/assets/web/client.js with pnpm build:phone-page, so building the APK doesn't need Node.
import { exposeDebugApi } from "../session/debug";
import { DesktopSession, toggleFullscreen } from "../session/desktop-session";

const RECONNECT_MS = 1000;
const STORAGE_KEY = "shinonome-pairing-code";

function byId<T extends HTMLElement>(id: string): T {
	return document.getElementById(id) as T;
}

const canvas = byId<HTMLCanvasElement>("screen");
const pairForm = byId<HTMLFormElement>("pair");
const codeInput = byId<HTMLInputElement>("code");
const pairError = byId("pair-error");
const notice = byId("notice");
const hud = byId("hud");

let pendingChallenge: Uint8Array<ArrayBuffer> | null = null;
let sessionEnded = false;

function readCode(): string | null {
	try {
		return localStorage.getItem(STORAGE_KEY);
	} catch {
		return null;
	}
}

function writeCode(code: string | null) {
	try {
		if (code) {
			localStorage.setItem(STORAGE_KEY, code);
		} else {
			localStorage.removeItem(STORAGE_KEY);
		}
	} catch {
		// Without storage the code is simply asked for again next time.
	}
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
