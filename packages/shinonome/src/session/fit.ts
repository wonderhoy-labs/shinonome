// The desktop takes the shape of the browser window, so there are no bars around it. It always fits within
// this box, whatever the window's real size, so a big screen doesn't cost latency and windows keep their scale.
const MAX_WIDTH = 1920;
const MAX_HEIGHT = 1200;
// Android's desktop isn't made for tall displays or extreme widths, so past these the picture gets bars.
const MIN_RATIO = 1;
const MAX_RATIO = 21 / 9;

function even(value: number): number {
	return Math.round(value / 2) * 2;
}

/**
 * The size to ask for so the picture fills the window. A desktop never goes portrait; one app alone may, since phone apps
 * suit a tall window, so `allowTall` turns the same box on its side for a window taller than it is wide.
 */
export function fitDesktopSize(windowWidth: number, windowHeight: number, allowTall = false): [number, number] {
	if (allowTall && windowHeight > windowWidth && windowWidth > 0) {
		const [height, width] = fitDesktopSize(windowHeight, windowWidth);
		return [width, height];
	}
	if (windowWidth <= 0 || windowHeight <= 0) {
		return [MAX_WIDTH, even((MAX_WIDTH * 9) / 16)];
	}
	const ratio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, windowWidth / windowHeight));
	const height = MAX_WIDTH / ratio;
	return height <= MAX_HEIGHT ? [MAX_WIDTH, even(height)] : [even(MAX_HEIGHT * ratio), MAX_HEIGHT];
}
