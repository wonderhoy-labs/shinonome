import { describe, expect, it } from "vitest";
import { PROTOCOL } from "./constants";
import { freeFileName, InstallError, installFailureReason, isServerReady, parseAppInfo, safeFileName } from "./phone";

describe("parseAppInfo", () => {
	it("reads an installed app", () => {
		expect(parseAppInfo("    versionCode=3 minSdk=34 targetSdk=37\n    versionName=0.2.0\n")).toEqual({
			installed: true,
			versionCode: 3,
			versionName: "0.2.0",
		});
	});

	it("reports a missing app", () => {
		expect(parseAppInfo("")).toEqual({ installed: false, versionCode: null, versionName: null });
	});
});

describe("installFailureReason", () => {
	it("picks out Android's reason", () => {
		expect(
			installFailureReason("Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package signed differently]"),
		).toBe("INSTALL_FAILED_UPDATE_INCOMPATIBLE");
	});

	it("falls back to the output", () => {
		expect(installFailureReason(" no space left \n")).toBe("no space left");
	});

	it("says so when there is nothing to go on", () => {
		expect(installFailureReason("")).toBe("Android didn't say why.");
	});
});

describe("InstallError", () => {
	it("asks for a removal only when that would help", () => {
		expect(new InstallError("INSTALL_FAILED_UPDATE_INCOMPATIBLE").needsUninstall).toBe(true);
		expect(new InstallError("INSTALL_FAILED_VERSION_DOWNGRADE").needsUninstall).toBe(true);
		expect(new InstallError("INSTALL_FAILED_INSUFFICIENT_STORAGE").needsUninstall).toBe(false);
	});
});

describe("isServerReady", () => {
	const log = `usb protocol: ${PROTOCOL}\ndisplay 6 created\nlistening\n`;

	it("wants the protocol and the listening line", () => {
		expect(isServerReady(log)).toBe(true);
	});

	it("copes with the line endings adb can add", () => {
		expect(isServerReady(log.replaceAll("\n", "\r\n"))).toBe(true);
	});

	it("turns down a server that is still starting", () => {
		expect(isServerReady(`usb protocol: ${PROTOCOL}\n`)).toBe(false);
	});

	it("turns down an older server with no USB socket", () => {
		expect(isServerReady("display 6 created\nlistening\n")).toBe(false);
	});

	it("turns down a server with another protocol", () => {
		expect(isServerReady(`usb protocol: ${PROTOCOL - 1}\nlistening\n`)).toBe(false);
	});

	it("treats no output as no server", () => {
		expect(isServerReady("")).toBe(false);
	});
});

describe("safeFileName", () => {
	it("keeps an ordinary name", () => {
		expect(safeFileName("Holiday photo.jpg")).toBe("Holiday photo.jpg");
	});

	it("replaces slashes and control characters", () => {
		expect(safeFileName("a/b\\c\u0007.txt")).toBe("a_b_c_.txt");
	});

	it("never gives an empty or special name", () => {
		expect(safeFileName("  ")).toBe("file");
		expect(safeFileName("..")).toBe("file");
	});

	it("shortens a long name but keeps its extension", () => {
		const name = safeFileName(`${"x".repeat(300)}.pdf`);
		expect(name.length).toBe(200);
		expect(name.endsWith(".pdf")).toBe(true);
	});
});

describe("freeFileName", () => {
	it("uses the name when it's free", () => {
		expect(freeFileName("notes.txt", new Set(["other.txt"]))).toBe("notes.txt");
	});

	it("numbers it the way Android does", () => {
		expect(freeFileName("notes.txt", new Set(["notes.txt", "notes (1).txt"]))).toBe("notes (2).txt");
		expect(freeFileName("README", new Set(["README"]))).toBe("README (1)");
	});
});
