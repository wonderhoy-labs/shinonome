import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { createAdbBridge } from "./dev-adb.ts";
import { thirdPartyNotices } from "./notices.ts";

const repo = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

const DEBUG_APK = "android/app/build/outputs/apk/debug/app-debug.apk";
const RELEASE_APK = "android/app/build/outputs/apk/release/app-release.apk";
const APK_PATH = "shinonome.apk";
const ADB_PATH = "/__shinonome/adb";

/** VERSION at the top of the repository, which the app's build reads too, and the versionCode it makes from it. */
function readAppVersion() {
	const name = readFileSync(repo("VERSION"), "utf8").trim();
	const [major = 0, minor = 0, patch = 0] = name.split(".").map(Number);
	return { code: major * 10_000 + minor * 100 + patch, name };
}

/**
 * WebSockets aren't covered by the same-origin policy, so any site you visit could otherwise use the bridge
 * to drive adb. Only this page may use it.
 */
function isFromThisPage(request: IncomingMessage): boolean {
	const { origin, host } = request.headers;
	if (!origin || !host) {
		return false;
	}
	try {
		const url = new URL(origin);
		const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
		return local && url.host === host;
	} catch {
		return false;
	}
}

function serveAdbBridge(httpServer: Server | null) {
	const adb = createAdbBridge();
	httpServer?.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
		if (new URL(request.url ?? "/", "http://localhost").pathname !== ADB_PATH) {
			return;
		}
		if (!isFromThisPage(request)) {
			socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
			socket.destroy();
			return;
		}
		adb.handleUpgrade(request, socket, head);
	});
}

/**
 * Puts the APK next to the site and tells the page what version it is.
 *
 * During development this also gives the page a way to reach an emulator, or a phone without stopping adb.
 */
export function shinonome(): Plugin {
	const version = readAppVersion();

	return {
		name: "shinonome",

		config: () => ({
			define: {
				__SHINONOME_VERSION__: JSON.stringify(version.name),
				__SHINONOME_VERSION_CODE__: version.code,
			},
		}),

		configureServer(server) {
			serveAdbBridge(server.httpServer as Server | null);

			server.middlewares.use(`/${APK_PATH}`, (_request, response) => {
				const path = process.env.SHINONOME_APK || repo(DEBUG_APK);
				if (!existsSync(path)) {
					response.statusCode = 404;
					response.end("Build the APK first: ./gradlew :app:assembleDebug");
					return;
				}
				response.setHeader("Content-Type", "application/vnd.android.package-archive");
				response.setHeader("Content-Length", statSync(path).size);
				createReadStream(path).pipe(response);
			});
		},

		generateBundle() {
			const path = process.env.SHINONOME_APK || repo(RELEASE_APK);
			if (!existsSync(path)) {
				this.error(
					`There's no APK at ${path}. The site carries it, so build it first: cd android && ./gradlew :app:assembleRelease`,
				);
			}
			this.emitFile({ type: "asset", fileName: APK_PATH, source: readFileSync(path) });
			this.emitFile({
				type: "asset",
				fileName: "third-party-licenses.txt",
				source: thirdPartyNotices(repo("web")),
			});
		},

		// This page can do anything adb can, so it only runs what came with it, and only talks to its own address.
		transformIndexHtml: {
			order: "post",
			handler(html, context) {
				if (context.server) {
					return html;
				}
				const policy = [
					"default-src 'self'",
					"img-src 'self' data:",
					"style-src 'self' 'unsafe-inline'",
					"font-src 'self' data:",
					"object-src 'none'",
					"base-uri 'none'",
				].join("; ");
				return html.replace(
					'<meta charset="utf-8" />',
					`<meta charset="utf-8" />\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`,
				);
			},
		},
	};
}
