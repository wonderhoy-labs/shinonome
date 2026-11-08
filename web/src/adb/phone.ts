import type { Adb, AdbSocket } from "@yume-chan/adb";
import { PackageManager } from "@yume-chan/android-bin";
import {
	APP_SCREEN,
	PACKAGE,
	SCRIPT_PATH,
	SERVER_DIR,
	SERVER_PATH,
	USB_PROTOCOL,
	USB_SOCKET,
} from "../shinonome/constants";

const INSTALL_CHUNK_BYTES = 256 * 1024;

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

/** Whether a server's log says it's up and holds the socket, and speaks this site's protocol. */
export function isServerReady(log: string): boolean {
	const lines = log.split("\n").map((line) => line.trim());
	return lines.includes(`usb protocol: ${USB_PROTOCOL}`) && lines.includes("listening");
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
	 * Runs the server from this site's own copy instead of the app, so the two always match and the app
	 * doesn't have to be installed. A copy that's already on the phone is left alone.
	 */
	async startServer(apk: Uint8Array<ArrayBuffer>, script: string): Promise<string> {
		const digest = toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", apk)));
		const existing = await this.shell(
			`umask 077; mkdir -p ${SERVER_DIR}; chmod 700 ${SERVER_DIR}; sha256sum ${SERVER_PATH} 2>/dev/null`,
		);
		const sync = await this.adb.sync();
		try {
			if (!existing.startsWith(digest)) {
				await sync.write({ filename: SERVER_PATH, file: streamOf(apk) as never });
			}
			await sync.write({ filename: SCRIPT_PATH, file: streamOf(new TextEncoder().encode(script)) as never });
		} finally {
			await sync.dispose();
		}
		// Afterwards, because adb can leave a pushed file open to everyone whatever mode it's asked for.
		return this.shell(
			`chmod 600 ${SERVER_PATH} ${SCRIPT_PATH}; SHINONOME_APK=${SERVER_PATH} sh ${SCRIPT_PATH} --no-network`,
		);
	}

	openDesktopSocket(): Promise<AdbSocket> {
		return this.adb.createSocket(USB_SOCKET);
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
