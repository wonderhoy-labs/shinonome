import type { DesktopSession } from "./desktop-session";

interface DebugApi {
	isConnected(): boolean;
	getStatus(): DesktopSession["currentStatus"];
	measureClicks: DesktopSession["measureClicks"];
	measureDrag: DesktopSession["measureDrag"];
	measureHover: DesktopSession["measureHover"];
	audioReport: DesktopSession["audioReport"];
	shell?: (command: string) => Promise<string>;
}

declare global {
	interface Window {
		shinonome?: DebugApi;
	}
}

/** What tools/measure.mjs uses to drive a page. A session can come and go underneath it. */
export function exposeDebugApi(getSession: () => DesktopSession | null, shell?: (command: string) => Promise<string>) {
	const session = () => {
		const current = getSession();
		if (!current) {
			throw new Error("No session is running.");
		}
		return current;
	};
	window.shinonome = {
		isConnected: () => getSession()?.isConnected ?? false,
		getStatus: () => getSession()?.currentStatus ?? null,
		measureClicks: (options) => session().measureClicks(options),
		measureDrag: (options) => session().measureDrag(options),
		measureHover: (options) => session().measureHover(options),
		audioReport: () => session().audioReport(),
		...(shell ? { shell } : {}),
	};
}
