// The phone's launcher apps, which a session can show one at a time with { kind: "app" }.

/** An app on the phone's launcher. */
export interface LaunchableApp {
	/** The activity that opens it, such as `com.android.settings/com.android.settings.Settings`, for SessionMode's app. */
	component: string;
	/** Its package. */
	packageName: string;
	/** Its name as the launcher shows it. */
	name: string;
	/** Its icon as a `data:` address for an image, or null if it wouldn't draw. Square and unmasked. */
	icon: string | null;
}

/**
 * The lines the server prints for `--list-apps`: `app`, the activity, the name and a base64 WebP icon, split by tabs.
 * Sorted by name, as a launcher would.
 */
export function parseLaunchableApps(output: string): LaunchableApp[] {
	const apps: LaunchableApp[] = [];
	const seen = new Set<string>();
	for (const line of output.split("\n")) {
		const [kind, component, name, icon] = line.trimEnd().split("\t");
		if (kind !== "app" || !component?.includes("/") || seen.has(component)) continue;
		seen.add(component);
		const packageName = component.slice(0, component.indexOf("/"));
		apps.push({
			component,
			packageName,
			name: name || packageName,
			icon: icon ? `data:image/webp;base64,${icon}` : null,
		});
	}
	return apps.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/** What the server prints for `--check-desktop`: null if the phone can make a desktop, or why it can't. */
export function parseDesktopCheck(output: string): string | null {
	const line = /^desktop: (.*)$/m.exec(output)?.[1]?.trim();
	if (line === undefined) throw new Error(output.trim() || "The server didn't say whether this phone has a desktop.");
	return line === "ok" ? null : line;
}
