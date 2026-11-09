// The messages between a browser and the server. Must match Server.java.

export const MessageType = {
	Video: 1,
	Status: 2,
	Pong: 3,
	AuthChallenge: 4,
	AuthResult: 5,
	Replaced: 6,
	Audio: 7,
	Clipboard: 8,
	Mouse: 16,
	Scroll: 17,
	Key: 18,
	Ping: 19,
	Stop: 20,
	AuthResponse: 21,
	KeyFrame: 22,
	Resize: 23,
	AudioControl: 24,
	SetClipboard: 25,
} as const;

export const AUTH_OK = 1;
export const AUTH_LOCKED_OUT = 2;

export const FLAG_CONFIG = 1;
export const FLAG_KEY = 2;
export const VIDEO_HEADER_BYTES = 26;
// The type, then when the packet's first sample was recorded, in microseconds on the phone's clock.
export const AUDIO_HEADER_BYTES = 9;

export const CLIPBOARD_PASTE = 1;
/** On a resize: give the desktop the phone's density, with more pixels to match. */
export const RESIZE_SHARP = 1;
// The server refuses messages over 1 MiB, which leaves room for the header.
export const MAX_CLIPBOARD_BYTES = 1_000_000;

export const MOUSE_MOVE = 0;
export const MOUSE_PRESS = 1;
export const MOUSE_RELEASE = 2;

export const KEY_DOWN = 0;
export const KEY_UP = 1;

export interface DesktopStatus {
	displayId: number;
	width: number;
	height: number;
	locked: boolean;
	usable: boolean;
	desktop: boolean;
	encoder: string;
	/** The desktop's density. Missing from servers before sharp mode. */
	dpi?: number;
	/** Where the phone's sound goes: "on" is to this browser. Missing from servers before sound. */
	audio?: "off" | "on" | "failed";
	/** Whether the phone's clipboard can be reached. */
	clipboard?: boolean;
	/**
	 * The name of the app in front on the desktop when it needs sharp mode and sharp mode is off, as React Native
	 * apps like Discord do. Null otherwise, and missing from servers before 0.3.3. See sharpSuggestion.
	 */
	needsSharp?: string | null;
	dropped: number;
}
