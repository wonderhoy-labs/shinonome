export const PACKAGE = "com.wonderhoylabs.shinonome";
export const APP_SCREEN = `${PACKAGE}/.MainActivity`;
export const REPO_URL = "https://github.com/wonderhoy-labs/shinonome";
export const RELEASES_URL = `${REPO_URL}/releases`;
export const APK_PATH = "shinonome.apk";

export const SERVER_DIR = "/data/local/tmp/shinonome";
export const SERVER_PATH = `${SERVER_DIR}/usb-server.apk`;
export const SCRIPT_PATH = `${SERVER_DIR}/start.sh`;
export const USB_SOCKET = "localabstract:shinonome";
// Must match USB_PROTOCOL in Server.java. A server with another number gets replaced by the one here.
export const USB_PROTOCOL = 2;
