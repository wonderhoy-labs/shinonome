import type { AdbSocket } from "@yume-chan/adb";
import { batchedWriter, FrameReader } from "./frames";
import type { DesktopSession } from "./session/desktop-session";

/**
 * Carries a desktop session over the server's socket until the socket ends, then detaches the session. Messages that
 * arrive once `isCurrent` says no are dropped, so a link being replaced can't feed the session stale video.
 */
export async function runDesktopLink(
	socket: AdbSocket,
	session: DesktopSession,
	isCurrent: () => boolean = () => true,
): Promise<void> {
	const writer = socket.writable.getWriter();
	// A lost link shows up on the reading side, which ends this.
	session.attach(batchedWriter((bytes) => void writer.write(bytes).catch(() => undefined)));
	const frames = new FrameReader();
	const reader = socket.readable.getReader();
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) {
				break;
			}
			frames.push(value, (data) => {
				if (isCurrent()) {
					session.receive(data);
				}
			});
		}
	} catch (error) {
		console.info("the link to the phone ended", error);
	}
	if (isCurrent()) {
		session.detach();
	}
}
