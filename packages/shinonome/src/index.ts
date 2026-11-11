// Shinonome as a library: the phone's desktop in any web page, over adb.
//
// Start the server with a Phone around a Tango Adb, open its socket, and run a DesktopSession on a canvas over it.
// The APK this package carries is the server, at "@wonderhoy-labs/shinonome/shinonome.apk".

export { APP_SCREEN, DESKTOP_SOCKET, PACKAGE, PROTOCOL, SERVER_DIR } from "./constants";
export { type LaunchableApp, parseDesktopCheck, parseLaunchableApps } from "./apps";
export { batchedWriter, FrameReader, frameMessage } from "./frames";
export { runDesktopLink } from "./link";
export { modeArgs, parseMode, type SessionMode, sameMode } from "./mode";
export {
	type AppInfo,
	freeFileName,
	InstallError,
	installFailureReason,
	isServerReady,
	Phone,
	parseAppInfo,
	safeFileName,
} from "./phone";
export { type AudioCounts, AudioPlayer } from "./session/audio";
export { exposeDebugApi } from "./session/debug";
export {
	DesktopSession,
	type Send,
	type SessionEvents,
	type SessionStats,
	type SoundState,
	toggleFullscreen,
} from "./session/desktop-session";
export { fitDesktopSize } from "./session/fit";
export { isPasteShortcut, keycodeFor, metaState } from "./session/keyboard";
export { type DesktopStatus, MessageType } from "./session/protocol";
export { sharpSuggestion } from "./session/sharp";
