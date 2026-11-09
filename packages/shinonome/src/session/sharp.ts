import type { DesktopStatus } from "./protocol";

/**
 * The app to offer sharp mode for, or null. The server names the app in front on the desktop when it needs the
 * phone's density and sharp mode is off: React Native apps such as Discord lay out with the phone's density whatever
 * display they're on, so on a desktop at another density their screens come apart.
 *
 * `sharp` is whether sharp mode is on, or on its way, so the offer goes away as soon as it's taken.
 * `declined` holds the apps someone has already said no for.
 */
export function sharpSuggestion(
	status: DesktopStatus | null,
	sharp: boolean,
	declined: ReadonlySet<string> = new Set(),
): string | null {
	const app = status?.needsSharp ?? null;
	return app && !sharp && !declined.has(app) ? app : null;
}
