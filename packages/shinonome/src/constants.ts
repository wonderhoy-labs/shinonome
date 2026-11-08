// Where Shinonome lives on the phone, and what its server is called.

/** The Android app's package. */
export const PACKAGE = "com.wonderhoylabs.shinonome";
export const APP_SCREEN = `${PACKAGE}/.MainActivity`;

/** Where the server, its log and its start script live on the phone. Only the shell user can read it. */
export const SERVER_DIR = "/data/local/tmp/shinonome";
export const SERVER_PATH = `${SERVER_DIR}/usb-server.apk`;
export const SCRIPT_PATH = `${SERVER_DIR}/start.sh`;
/** The desktop server's local socket, which adb can open. */
export const DESKTOP_SOCKET = "localabstract:shinonome";
/**
 * The messages this library speaks. Must match USB_PROTOCOL in Server.java. A running server with another number gets
 * replaced by the one handed to startServer.
 */
export const PROTOCOL = 2;
