#!/usr/bin/env node
// Drives a real browser against the phone and reports what it measured. Needs a debug build of the
// app, which contains the test window that this clicks and drags, and a session already running.
//
//   node tools/measure.mjs --serial 192.168.1.50:40000 --host 192.168.1.50 --drag 30 --clicks 30
//
// The client gets its own throwaway profile, and is told to accept the phone's self-signed
// certificate unless --real-certificate is set.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
    options: {
        serial: { type: 'string' },
        host: { type: 'string' },
        port: { type: 'string', default: '27183' },
        drag: { type: 'string', default: '30' },
        clicks: { type: 'string', default: '30' },
        rounds: { type: 'string', default: '1' },
        screenshot: { type: 'string' },
        out: { type: 'string' },
        browser: { type: 'string', default: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
        'open-settings': { type: 'boolean', default: true },
        'no-open-settings': { type: 'boolean', default: false },
        'wait-unlock': { type: 'string', default: '0' },
        // Go through the browser's certificate warning like a real user, instead of skipping it.
        'real-certificate': { type: 'boolean', default: false },
        // Only report whether the client can run, which works on a locked phone.
        probe: { type: 'boolean', default: false },
        // Send real mouse, wheel and key events to the page and save a screenshot after each.
        'exercise-input': { type: 'string' },
        'close-test-window': { type: 'boolean', default: false },
        // Drag the test window with real mouse events paced like a person, and report whether it moved.
        'real-drag': { type: 'boolean', default: false },
    },
});

const DEBUG_PORT = 9333;
const TEST_WINDOW = 'com.wonderhoylabs.shinonome/.TestWindowActivity';
const TITLE_BAR_Y = 24;
const TEXT_BOX_Y = 90;
const PRESS_TARGET_Y = 300;
const HOVER_STEPS = 10;
const DRAG_STEPS = 40;
const MOVE_INTERVAL_MS = 16;
const HOVER_PAUSE_MS = 400;
const PRESS_PAUSE_MS = 150;
const RELEASE_SETTLE_MS = 1000;
const REAL_DRAG_X = 120;
const REAL_DRAG_Y = 80;
const REAL_DRAG_ROUNDS = 3;
const REAL_DRAG_FLIP_TOP = 300;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function adb(...command) {
    return execFileSync('adb', ['-s', args.serial, ...command], { encoding: 'utf8' }).trim();
}

// Reads the test window's live bounds, because `am stack list` can report old ones.
let lastWindow = null;

function testWindow() {
    const tasks = adb('shell', 'dumpsys', 'activity', 'activities').split(/\n(?=\s*\* Task\{)/);
    // By activity, because the app's main screen can be visible on the phone as well.
  const task = tasks.find((t) => t.includes('TestWindowActivity') && t.includes(' visible=true'));
    const match = task && /mBounds=Rect\((-?\d+), (-?\d+) - (-?\d+), (-?\d+)\)/.exec(task);
    if (match) {
        const [left, top, right, bottom] = match.slice(1).map(Number);
        lastWindow = { left, top, right, bottom };
    }
    if (!lastWindow) {
        throw new Error('No visible test window to measure with');
    }
    return lastWindow;
}

function phoneVitals() {
    const battery = adb('shell', 'dumpsys battery');
    const thermal = adb('shell', 'dumpsys thermalservice');
    const field = (name) => (battery.match(new RegExp(`${name}: (.+)`)) || [])[1];
    return {
        at: new Date().toISOString(),
        batteryPercent: Number(field('level')),
        batteryCelsius: Number(field('temperature')) / 10,
        charging: field('AC powered') === 'true' || field('USB powered') === 'true',
        thermalStatus: Number((thermal.match(/Thermal Status: (\d+)/) || [])[1]),
    };
}

class Page {
    constructor(socket) {
        this.socket = socket;
        this.nextId = 1;
        this.pending = new Map();
        socket.addEventListener('message', (event) => {
            const message = JSON.parse(event.data);
            const entry = this.pending.get(message.id);
            if (entry) {
                this.pending.delete(message.id);
                message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
            }
        });
    }

    static async open(browserPort) {
        let targets;
        for (let i = 0; i < 40 && !targets; i++) {
            try {
                const response = await fetch(`http://127.0.0.1:${browserPort}/json/list`);
                const list = await response.json();
                const page = list.find((t) => t.type === 'page');
                if (page) {
                    targets = page;
                }
            } catch {
                await sleep(250);
            }
        }
        if (!targets) {
            throw new Error('The browser did not expose a page to debug');
        }
        const socket = new WebSocket(targets.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
            socket.addEventListener('open', resolve, { once: true });
            socket.addEventListener('error', reject, { once: true });
        });
        return new Page(socket);
    }

    send(method, params = {}) {
        const id = this.nextId++;
        this.socket.send(JSON.stringify({ id, method, params }));
        return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    }

    async evaluate(expression) {
        const { result, exceptionDetails } = await this.send('Runtime.evaluate',
            { expression, awaitPromise: true, returnByValue: true });
        if (exceptionDetails) {
            throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
        }
        return result.value;
    }

    async waitFor(expression, timeoutMs, what) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (await this.evaluate(expression).catch(() => false)) {
                return;
            }
            await sleep(250);
        }
        throw new Error(`Timed out waiting for ${what}`);
    }
}

// Moves through a browser's certificate warning the way a person would.
async function clickThroughWarning(page) {
    await sleep(2500);
    const clicked = await page.evaluate(`(() => {
    const details = document.getElementById('details-button');
    const proceed = document.getElementById('proceed-link');
    if (!details || !proceed) return false;
    details.click();
    proceed.click();
    return true;
  })()`);
    console.log('certificate warning shown:', clicked);
    await sleep(2500);
}

async function sendMouse(page, type, x, y, extra = {}) {
    await page.send('Input.dispatchMouseEvent', { type, x, y, ...extra });
}

async function sendKey(page, code, key, keyCode) {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', code, key, windowsVirtualKeyCode: keyCode });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, windowsVirtualKeyCode: keyCode });
}

// Maps a point on the desktop to where it sits in the browser window.
async function desktopToClient(page) {
    const toClient = await page.evaluate(`(() => {
    const canvas = document.getElementById('screen');
    const box = canvas.getBoundingClientRect();
    const scale = Math.min(box.width / canvas.width, box.height / canvas.height);
    return {
      scale,
      left: box.left + (box.width - canvas.width * scale) / 2,
      top: box.top + (box.height - canvas.height * scale) / 2,
    };
  })()`);
    return ([x, y]) => [toClient.left + x * toClient.scale, toClient.top + y * toClient.scale];
}

// Hovers, pauses, presses, moves slowly and releases, the way a person drags a window. This goes
// through the page's own handlers, which measureDrag skips, and checks the window's live bounds.
async function realDrag(page) {
    const at = await desktopToClient(page);
    const before = testWindow();
    const start = [Math.round((before.left + before.right) / 2), before.top + TITLE_BAR_Y];
    const point = (i, steps, dx, dy) => at([start[0] + dx * i / steps, start[1] + dy * i / steps]);
    // Heads back up from the lower half of the screen, so repeated runs keep the title bar on it.
    const direction = before.top > REAL_DRAG_FLIP_TOP ? -1 : 1;
    const wanted = [REAL_DRAG_X * direction, REAL_DRAG_Y * direction];

    for (let i = HOVER_STEPS; i >= 0; i--) {
        await sendMouse(page, 'mouseMoved', ...point(i, HOVER_STEPS, 60, 60));
        await sleep(MOVE_INTERVAL_MS);
    }
    await sleep(HOVER_PAUSE_MS);
    await sendMouse(page, 'mousePressed', ...at(start), { button: 'left', buttons: 1, clickCount: 1 });
    await sleep(PRESS_PAUSE_MS);
    for (let i = 1; i <= DRAG_STEPS; i++) {
        await sendMouse(page, 'mouseMoved', ...point(i, DRAG_STEPS, ...wanted), { button: 'left', buttons: 1 });
        await sleep(MOVE_INTERVAL_MS);
    }
    await sleep(PRESS_PAUSE_MS);
    const midway = testWindow();
    await sendMouse(page, 'mouseReleased', ...point(DRAG_STEPS, DRAG_STEPS, ...wanted),
        { button: 'left', buttons: 0, clickCount: 1 });
    await sleep(RELEASE_SETTLE_MS);
    const after = testWindow();
    return {
        before,
        midway,
        after,
        moved: [after.left - before.left, after.top - before.top],
        wanted,
    };
}

// Goes through the page's own event handlers, unlike measureClicks and measureDrag.
async function exerciseInput(page, directory) {
    const at = await desktopToClient(page);
    const shot = async (name) => {
        await sleep(1800);
        const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(join(directory, `input-${name}.png`), Buffer.from(data, 'base64'));
    };
    const click = async (point, button = 'left') => {
        const [x, y] = at(point);
        const mask = button === 'left' ? 1 : 2;
        await sendMouse(page, 'mouseMoved', x, y);
        await sendMouse(page, 'mousePressed', x, y, { button, buttons: mask, clickCount: 1 });
        await sendMouse(page, 'mouseReleased', x, y, { button, buttons: 0, clickCount: 1 });
    };

    const { left, top } = testWindow();
    await click([left + 200, top + TEXT_BOX_Y]);
    for (const letter of 'wifi') {
        await sendKey(page, `Key${letter.toUpperCase()}`, letter, letter.toUpperCase().charCodeAt(0));
    }
    await shot('1-typed');

    await click([left + 200, top + PRESS_TARGET_Y], 'right');
    await shot('2-right-click');
}

function launchBrowser(profile, url) {
    return spawn(args.browser, [
        `--user-data-dir=${profile}`,
        `--remote-debugging-port=${DEBUG_PORT}`,
        ...(args['real-certificate'] ? [] : ['--ignore-certificate-errors']),
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--window-size=1280,760',
        url,
    ], { stdio: 'ignore' });
}

async function main() {
    const url = `https://${args.host}:${args.port}/`;
    const code = adb('shell', 'cat', '/data/local/tmp/shinonome/pairing-code');
    const profile = mkdtempSync(join(tmpdir(), 'shinonome-measure-'));
    const browser = launchBrowser(profile, url);

    const results = { url, vitalsBefore: null, vitalsAfter: null, rounds: [] };
    try {
        const page = await Page.open(DEBUG_PORT);
        await page.send('Page.enable');
        await page.send('Runtime.enable');
        if (args['real-certificate']) {
            await clickThroughWarning(page);
        }
        await page.waitFor('typeof window.shinonome === "object"', 15000, 'the client page to load');
        await page.evaluate(`localStorage.setItem('shinonome-pairing-code', ${JSON.stringify(code)}); location.reload()`);
        await sleep(1000);
        await page.waitFor('typeof window.shinonome === "object" && window.shinonome.isConnected()', 15000, 'pairing to finish');
        await page.waitFor('window.shinonome.getStatus() !== null', 5000, 'the first status message');

        let status = await page.evaluate('window.shinonome.getStatus()');
        results.status = status;
        console.log('connected:', JSON.stringify(status));
        if (args.probe) {
            console.log('client:', JSON.stringify(await page.evaluate(`({
        secureContext: window.isSecureContext,
        videoDecoder: typeof VideoDecoder,
        address: location.href,
      })`)));
            return;
        }
        const waitUnlockMs = Number(args['wait-unlock']) * 1000;
        if (!status.usable && waitUnlockMs > 0) {
            console.log('phone is locked, waiting for it to be unlocked');
            await page.waitFor('window.shinonome.getStatus().usable', waitUnlockMs, 'the phone to be unlocked');
            status = await page.evaluate('window.shinonome.getStatus()');
        }
        if (!status.usable) {
            throw new Error('The phone is locked, so the desktop session cannot start');
        }

        if (args['open-settings'] && !args['no-open-settings']) {
            await sleep(2000);
            // Nothing important should sit behind the test window, in case a click goes astray.
            adb('shell', 'am', 'force-stop', 'com.android.settings');
            adb('shell', 'am', 'start', '--display', String(status.displayId), '-n', TEST_WINDOW);
            await sleep(4000);
        }
        if (args['exercise-input']) {
            await exerciseInput(page, args['exercise-input']);
        }
        if (args['real-drag']) {
            const rounds = [];
            for (let i = 0; i < REAL_DRAG_ROUNDS; i++) {
                rounds.push(await realDrag(page));
            }
            results.realDrag = rounds;
            for (const round of rounds) {
                console.log('real drag:', JSON.stringify(round));
            }
        }
        results.vitalsBefore = phoneVitals();

        const rounds = Number(args.rounds);
        for (let round = 0; round < rounds; round++) {
            const entry = { round, startedAt: new Date().toISOString() };
            if (Number(args.clicks) > 0) {
                const { left, top } = testWindow();
                const target = [left + 200, top + PRESS_TARGET_Y];
                entry.clicks = await page.evaluate(`window.shinonome.measureClicks(${JSON.stringify({
                    targets: [target], count: Number(args.clicks),
                })})`);
            }
            if (Number(args.drag) > 0) {
                const { left, right, top } = testWindow();
                entry.drag = await page.evaluate(`window.shinonome.measureDrag(${JSON.stringify({
                    seconds: Number(args.drag),
                    start: [Math.round((left + right) / 2), top + TITLE_BAR_Y],
                })})`);
            }
            entry.vitals = phoneVitals();
            results.rounds.push(entry);
            console.log(JSON.stringify(entry));
            if (args.out) {
                writeFileSync(args.out, JSON.stringify(results, null, 2));
            }
        }

        results.vitalsAfter = phoneVitals();
        results.status = await page.evaluate('window.shinonome.getStatus()');
        if (args.screenshot) {
            const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
            writeFileSync(args.screenshot, Buffer.from(data, 'base64'));
        }
        if (args.out) {
            writeFileSync(args.out, JSON.stringify(results, null, 2));
        }
        console.log('summary:', JSON.stringify({ before: results.vitalsBefore, after: results.vitalsAfter }));
        if (args['close-test-window']) {
            adb('shell', 'am', 'force-stop', 'com.wonderhoylabs.shinonome');
        }
    } finally {
        browser.kill();
        await sleep(500);
        rmSync(profile, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error('FAILED:', error.message);
    process.exit(1);
});
