// What a session shows. The server takes one of these when it starts, and a running server says which in its log.

/**
 * What a session shows: a new desktop beside the phone's screen (the usual), the phone's own screen as it is, or one app
 * alone filling the picture. An app is a link, such as `airi://app/org.gnome.Calculator.desktop`, or an activity, such
 * as `com.google.android.calculator/com.android.calculator2.Calculator`.
 */
export type SessionMode = { kind: "desktop" } | { kind: "mirror" } | { kind: "app"; app: string };

/** The server options for a mode, to hand to Phone.startServer along with any others. */
export function modeArgs(mode: SessionMode): string[] {
	switch (mode.kind) {
		case "desktop":
			return [];
		case "mirror":
			return ["--mirror"];
		case "app":
			return ["--app", mode.app];
	}
}

/** The mode a server's log says it runs in, or null if the log doesn't say. Servers before 0.4.0 only made desktops. */
export function parseMode(log: string): SessionMode | null {
	for (const line of log.split("\n")) {
		const match = /^mode: (desktop|mirror|app)(?: (.+))?$/.exec(line.trim());
		if (!match) continue;
		if (match[1] === "app") return match[2] ? { kind: "app", app: match[2] } : null;
		return { kind: match[1] as "desktop" | "mirror" };
	}
	return null;
}

/** Whether two modes show the same thing, so a server running one needn't be restarted for the other. */
export function sameMode(a: SessionMode, b: SessionMode): boolean {
	return a.kind === b.kind && (a.kind !== "app" || (b.kind === "app" && a.app === b.app));
}
