// The messages between a browser and the server. Must match Server.java.

export const MessageType = {
	Video: 1,
	Status: 2,
	Pong: 3,
	AuthChallenge: 4,
	AuthResult: 5,
	Replaced: 6,
	Mouse: 16,
	Scroll: 17,
	Key: 18,
	Ping: 19,
	Stop: 20,
	AuthResponse: 21,
	KeyFrame: 22,
	Resize: 23,
} as const;

export const AUTH_OK = 1;
export const AUTH_LOCKED_OUT = 2;

export const FLAG_CONFIG = 1;
export const FLAG_KEY = 2;
export const VIDEO_HEADER_BYTES = 26;

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
	dropped: number;
}
