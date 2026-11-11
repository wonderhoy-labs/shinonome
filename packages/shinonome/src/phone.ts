import type { Adb, AdbSocket } from "@yume-chan/adb";
import { PackageManager } from "@yume-chan/android-bin";
import startScript from "../../../android/app/src/main/assets/start.sh?raw";
import { type LaunchableApp, parseDesktopCheck, parseLaunchableApps } from "./apps";
import {
	APP_SCREEN,
	DESKTOP_SOCKET,
	PACKAGE,
	PROTOCOL,
	SCRIPT_PATH,
	SERVER_DIR,
	SERVER_MAIN,
	SERVER_PATH,
} from "./constants";
import { parseMode, type SessionMode } from "./mode";

const INSTALL_CHUNK_BYTES = 256 * 1024;
const DOWNLOADS = "/sdcard/Download";
const MAX_NAME_LENGTH = 200;

export interface AppInfo {
	installed: boolean;
	versionName: string | null;
	versionCode: number | null;
}

export function parseAppInfo(dumpsysOutput: string): AppInfo {
	const code = /versionCode=(\d+)/.exec(dumpsysOutput)?.[1];
	const name = /versionName=(\S+)/.exec(dumpsysOutput)?.[1];
	return {
		installed: code !== undefined,
		versionName: name ?? null,
		versionCode: code === undefined ? null : Number(code),
	};
}

/** Android's own explanation, or the command's output if it doesn't have one. */
export function installFailureReason(output: string): string {
	return /\[?(INSTALL_[A-Z_]+)[\]:]?/.exec(output)?.[1] ?? (output.trim() || "Android didn't say why.");
}

/** Whether a server's log says it's up and holds the socket, and speaks this library's protocol. */
export function isServerReady(log: string): boolean {
	const lines = log.split("\n").map((line) => line.trim());
	return lines.includes(`usb protocol: ${PROTOCOL}`) && lines.includes("listening");
}

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function streamOf(bytes: Uint8Array, onSent?: (fraction: number) => void): ReadableStream<Uint8Array> {
	let sent = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (sent >= bytes.length) {
				controller.close();
				return;
			}
			const chunk = bytes.subarray(sent, sent + INSTALL_CHUNK_BYTES);
			sent += chunk.length;
			onSent?.(sent / bytes.length);
			controller.enqueue(chunk);
		},
	});
}

/** Quotes one argument for the phone's shell. */
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/** A file's name as the phone can store it: no slashes or control characters, and not too long. */
export function safeFileName(name: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes.
	const cleaned = name.replace(/[\u0000-\u001f\u007f/\\]/g, "_").trim();
	if (cleaned === "" || cleaned === "." || cleaned === "..") {
		return "file";
	}
	if (cleaned.length <= MAX_NAME_LENGTH) {
		return cleaned;
	}
	const dot = cleaned.lastIndexOf(".");
	const extension = dot > 0 && cleaned.length - dot <= 16 ? cleaned.slice(dot) : "";
	return cleaned.slice(0, MAX_NAME_LENGTH - extension.length) + extension;
}

/** The name, or the first "name (n).ext" that isn't taken, the way Android names a second download. */
export function freeFileName(name: string, taken: ReadonlySet<string>): string {
	if (!taken.has(name)) {
		return name;
	}
	const dot = name.lastIndexOf(".");
	const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
	for (let n = 1; ; n++) {
		const candidate = `${stem} (${n})${extension}`;
		if (!taken.has(candidate)) {
			return candidate;
		}
	}
}

function counted(file: File, onSent: (fraction: number) => void): ReadableStream<Uint8Array> {
	let sent = 0;
	return file.stream().pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				sent += chunk.length;
				onSent(file.size > 0 ? sent / file.size : 1);
				controller.enqueue(chunk);
			},
		}),
	);
}

/** A phone reached through adb, and the things Shinonome needs from it. */
export class Phone {
	constructor(
		readonly adb: Adb,
		readonly name: string,
	) {}

	get disconnected(): Promise<unknown> {
		return this.adb.disconnected;
	}

	/** As an array, because a string would be split up and lose its quotes on the way to the phone's shell. */
	readonly shell = (command: string): Promise<string> => this.adb.subprocess.noneProtocol.spawnWaitText([command]);

	async appInfo(): Promise<AppInfo> {
		return parseAppInfo(
			await this.shell(`dumpsys package ${PACKAGE} | grep -E 'versionCode=|versionName=' | head -2`),
		);
	}

	/**
	 * Hands an APK to Android's installer. Throws with Android's reason if it refuses.
	 *
	 * This pushes a temporary file instead of streaming straight into the installer. With streaming, closing
	 * the input also closes the socket that the installer's answer comes back on, so success looks like failure.
	 */
	async install(apk: Uint8Array, onProgress: (fraction: number) => void): Promise<void> {
		try {
			await new PackageManager(this.adb).pushAndInstallStream(streamOf(apk, onProgress) as never);
		} catch (error) {
			throw new InstallError(installFailureReason(error instanceof Error ? error.message : String(error)));
		}
	}

	async uninstall(): Promise<void> {
		await this.shell(`pm uninstall ${PACKAGE}`);
	}

	/** Opens the app on the phone's screen. Its first open also unpacks the start script for adb users. */
	async openApp(): Promise<void> {
		const output = await this.shell(`am start -n ${APP_SCREEN}`);
		if (/^Error/m.test(output)) {
			throw new Error(output.trim());
		}
	}

	/**
	 * By reading a running server's log, rather than just trying the socket, because any app on the phone
	 * could be listening on that name. The server only logs this once it holds the name itself.
	 */
	async isServerRunning(): Promise<boolean> {
		return isServerReady(await this.shell(`pidof shinonome-server >/dev/null && cat ${SERVER_DIR}/server.log`));
	}

	/**
	 * What the running server shows, from its log, or null if none is running. A server before 0.4.0 says nothing and
	 * made a desktop. Restart it with startServer to show something else.
	 */
	async serverMode(): Promise<SessionMode | null> {
		const log = await this.shell(`pidof shinonome-server >/dev/null && cat ${SERVER_DIR}/server.log`);
		if (!isServerReady(log)) return null;
		return parseMode(log) ?? { kind: "desktop" };
	}

	/**
	 * Runs the server from the APK handed over, usually the one this package carries, instead of the installed app,
	 * so the two always match and the app doesn't have to be installed. A copy that's already on the phone is left
	 * alone. Returns the server's log, which says `incompatible: …` if this phone can't make a desktop.
	 */
	async startServer(apk: Uint8Array<ArrayBuffer>, extraArgs: string[] = []): Promise<string> {
		await this.pushServer(apk, true);
		return this.shell(
			`SHINONOME_APK=${SERVER_PATH} sh ${SCRIPT_PATH} --no-network ${extraArgs.map(shellQuote).join(" ")}`,
		);
	}

	/**
	 * The apps on the phone's launcher, with their names and icons, sorted by name. Any of them can be shown alone with
	 * `{ kind: "app", app: component }`. Asks the server in the APK handed over, which is copied to the phone as for
	 * startServer, and doesn't disturb a running session. Takes a few seconds.
	 */
	async launchableApps(apk: Uint8Array<ArrayBuffer>, iconSize = 96): Promise<LaunchableApp[]> {
		return parseLaunchableApps(await this.runServerTool(apk, ["--list-apps", "--icon-size", String(iconSize)]));
	}

	/**
	 * Null if this phone can make a desktop, or Android's reason it can't, such as desktop windows being turned off. The
	 * phone's screen and one app alone work without one. Asks the server in the APK handed over, as launchableApps does.
	 */
	async desktopProblem(apk: Uint8Array<ArrayBuffer>): Promise<string | null> {
		return parseDesktopCheck(await this.runServerTool(apk, ["--check-desktop"]));
	}

	/** Runs the server for a quick answer instead of a session. */
	private async runServerTool(apk: Uint8Array<ArrayBuffer>, args: string[]): Promise<string> {
		await this.pushServer(apk, false);
		return this.shell(
			`CLASSPATH=${SERVER_PATH} app_process / --nice-name=shinonome-tool ${SERVER_MAIN} ${args.map(shellQuote).join(" ")}`,
		);
	}

	/** Copies the server, and the start script if a session needs it, unless the same copy is already there. */
	private async pushServer(apk: Uint8Array<ArrayBuffer>, withScript: boolean) {
		const digest = toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", apk)));
		const existing = await this.shell(
			`umask 077; mkdir -p ${SERVER_DIR}; chmod 700 ${SERVER_DIR}; sha256sum ${SERVER_PATH} 2>/dev/null`,
		);
		const fresh = existing.startsWith(digest);
		if (fresh && !withScript) return;
		const sync = await this.adb.sync();
		try {
			if (!fresh) {
				// Beside it, then moved into place, so a server still running from the old copy keeps its file.
				await sync.write({ filename: `${SERVER_PATH}.new`, file: streamOf(apk) as never });
			}
			if (withScript) {
				await sync.write({
					filename: SCRIPT_PATH,
					file: streamOf(new TextEncoder().encode(startScript)) as never,
				});
			}
		} finally {
			await sync.dispose();
		}
		// Afterwards, because adb can leave a pushed file open to everyone whatever mode it's asked for.
		const files = withScript ? `${SERVER_PATH} ${SCRIPT_PATH}` : SERVER_PATH;
		await this.shell(`${fresh ? "" : `mv -f ${SERVER_PATH}.new ${SERVER_PATH}; `}chmod 600 ${files}`);
	}

	/**
	 * Copies a file into the phone's Downloads, beside anything already there, and returns the name it got. Android
	 * indexes files written there by itself, so they show up in the Files app straight away.
	 */
	async saveToDownloads(file: File, onSent: (fraction: number) => void): Promise<string> {
		const listing = await this.shell(`ls -1 ${DOWNLOADS} 2>/dev/null`);
		const name = freeFileName(safeFileName(file.name), new Set(listing.split("\n")));
		const sync = await this.adb.sync();
		try {
			await sync.write({
				filename: `${DOWNLOADS}/${name}`,
				file: counted(file, onSent) as never,
				mtime: Math.floor(file.lastModified / 1000),
			});
		} finally {
			await sync.dispose();
		}
		return name;
	}

	openDesktopSocket(): Promise<AdbSocket> {
		return this.adb.createSocket(DESKTOP_SOCKET);
	}

	async close(): Promise<void> {
		await this.adb.close();
	}
}

export class InstallError extends Error {
	constructor(readonly reason: string) {
		super(reason);
		this.name = "InstallError";
	}

	/** A copy that's signed with another key, or that's newer, has to be removed first. */
	get needsUninstall(): boolean {
		return this.reason.includes("UPDATE_INCOMPATIBLE") || this.reason.includes("VERSION_DOWNGRADE");
	}
}
