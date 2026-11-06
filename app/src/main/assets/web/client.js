'use strict';

// Message types. Must match Server.java.
const TYPE_VIDEO = 1;
const TYPE_STATUS = 2;
const TYPE_PONG = 3;
const TYPE_AUTH_CHALLENGE = 4;
const TYPE_AUTH_RESULT = 5;
const TYPE_REPLACED = 6;
const TYPE_MOUSE = 16;
const TYPE_SCROLL = 17;
const TYPE_KEY = 18;
const TYPE_PING = 19;
const TYPE_STOP = 20;
const TYPE_AUTH_RESPONSE = 21;
const TYPE_KEY_FRAME = 22;

const AUTH_OK = 1;
const AUTH_LOCKED_OUT = 2;

const FLAG_CONFIG = 1;
const FLAG_KEY = 2;
const VIDEO_HEADER_BYTES = 26;

const MOUSE_MOVE = 0;
const MOUSE_PRESS = 1;
const MOUSE_RELEASE = 2;
// Left, right and middle. MouseEvent.buttons and Android's MotionEvent.BUTTON_* use the same bits.
const MOUSE_BUTTON_BITS = [1, 2, 4];

const KEY_DOWN = 0;
const KEY_UP = 1;
const META_SHIFT = 0x41;
const META_ALT = 0x12;
const META_CTRL = 0x3000;
const META_SYSTEM = 0x30000;

const KEYCODE_CTRL_LEFT = 113;
const KEYCODE_META_LEFT = 117;

const PING_INTERVAL_MS = 2000;
const CLOCK_SAMPLES = 8;
const MAX_DECODE_QUEUE = 6;
const RECONNECT_MS = 1000;
const STORAGE_KEY = 'shinonome-pairing-code';
const PROBE_WIDTH = 240;
const PROBE_HEIGHT = 135;
const PROBE_CHANGE_LEVEL = 10;
const PROBE_CHANGED_CELLS = 3;

// KeyboardEvent.code to Android KeyEvent.KEYCODE_*.
const KEYCODES = {
  Digit0: 7, Digit1: 8, Digit2: 9, Digit3: 10, Digit4: 11, Digit5: 12, Digit6: 13, Digit7: 14, Digit8: 15, Digit9: 16,
  KeyA: 29, KeyB: 30, KeyC: 31, KeyD: 32, KeyE: 33, KeyF: 34, KeyG: 35, KeyH: 36, KeyI: 37, KeyJ: 38, KeyK: 39,
  KeyL: 40, KeyM: 41, KeyN: 42, KeyO: 43, KeyP: 44, KeyQ: 45, KeyR: 46, KeyS: 47, KeyT: 48, KeyU: 49, KeyV: 50,
  KeyW: 51, KeyX: 52, KeyY: 53, KeyZ: 54,
  Comma: 55, Period: 56, Tab: 61, Space: 62, Enter: 66, Backspace: 67, Backquote: 68, Minus: 69, Equal: 70,
  BracketLeft: 71, BracketRight: 72, Backslash: 73, Semicolon: 74, Quote: 75, Slash: 76,
  ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22,
  PageUp: 92, PageDown: 93, Escape: 111, Delete: 112, CapsLock: 115, Home: 122, End: 123, Insert: 124,
  F1: 131, F2: 132, F3: 133, F4: 134, F5: 135, F6: 136, F7: 137, F8: 138, F9: 139, F10: 140, F11: 141, F12: 142,
  ShiftLeft: 59, ShiftRight: 60, AltLeft: 57, AltRight: 58, ControlRight: 114,
  Numpad0: 144, Numpad1: 145, Numpad2: 146, Numpad3: 147, Numpad4: 148, Numpad5: 149, Numpad6: 150, Numpad7: 151,
  Numpad8: 152, Numpad9: 153, NumpadDivide: 154, NumpadMultiply: 155, NumpadSubtract: 156, NumpadAdd: 157,
  NumpadDecimal: 158, NumpadEnter: 160, NumpadEqual: 161,
};

const isMac = /Mac/.test(navigator.platform);
// Android shortcuts use Ctrl where a Mac uses Cmd, so Cmd sends Ctrl there and Control reaches the Android system key.
KEYCODES.ControlLeft = isMac ? KEYCODE_META_LEFT : KEYCODE_CTRL_LEFT;
KEYCODES.ControlRight = isMac ? KEYCODE_META_LEFT : 114;
KEYCODES.MetaLeft = isMac ? KEYCODE_CTRL_LEFT : KEYCODE_META_LEFT;
KEYCODES.MetaRight = isMac ? KEYCODE_CTRL_LEFT : KEYCODE_META_LEFT;

const canvas = document.getElementById('screen');
const context = canvas.getContext('2d', {alpha: false, desynchronized: true});
const pairForm = document.getElementById('pair');
const codeInput = document.getElementById('code');
const pairError = document.getElementById('pair-error');
const notice = document.getElementById('notice');
const hud = document.getElementById('hud');

let socket = null;
let decoder = null;
let configBytes = null;
let codecString = null;
let waitingForKey = true;
let pendingChallenge = null;
let authenticated = false;
let sessionEnded = false;
let pingTimer = 0;
let status = null;

let clockOffsetUs = null;
const clockSamples = [];
const frameMeta = new Map();

const second = {frames: 0, bytes: 0, latencyTotal: 0, latencyCount: 0};
const heldKeys = new Set();
let heldButtons = 0;
let pointerAt = [0, 0];

function readCode() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeCode(code) {
  try {
    if (code) {
      localStorage.setItem(STORAGE_KEY, code);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Without storage the code is simply asked for again next time.
  }
}

function normalizeCode(raw) {
  return raw.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

function showNotice(text) {
  notice.textContent = text;
  notice.hidden = !text;
}

function showPairForm(error) {
  pairError.textContent = error || '';
  pairForm.hidden = false;
  codeInput.focus();
}

// ---- Connection ----

function connect() {
  if (sessionEnded) {
    return;
  }
  authenticated = false;
  socket = new WebSocket(`wss://${location.host}/ws`);
  socket.binaryType = 'arraybuffer';
  socket.onmessage = onMessage;
  socket.onclose = onClose;
}

function onClose() {
  clearInterval(pingTimer);
  if (sessionEnded) {
    return;
  }
  releaseHeldKeys();
  // The server has already lifted everything this connection was holding.
  heldButtons = 0;
  if (pairForm.hidden) {
    showNotice('Connection lost. Reconnecting…');
  }
  setTimeout(connect, RECONNECT_MS);
}

function send(buffer) {
  if (socket && socket.readyState === WebSocket.OPEN && authenticated) {
    socket.send(buffer);
  }
}

function onMessage(event) {
  const view = new DataView(event.data);
  switch (view.getUint8(0)) {
    case TYPE_VIDEO:
      onVideo(view, event.data);
      break;
    case TYPE_STATUS:
      onStatus(JSON.parse(new TextDecoder().decode(new Uint8Array(event.data, 1))));
      break;
    case TYPE_PONG:
      onPong(view);
      break;
    case TYPE_AUTH_CHALLENGE:
      onChallenge(new Uint8Array(event.data, 1));
      break;
    case TYPE_AUTH_RESULT:
      onAuthResult(view.getUint8(1));
      break;
    case TYPE_REPLACED:
      onReplaced();
      break;
  }
}

async function onChallenge(nonce) {
  pendingChallenge = nonce;
  const code = readCode();
  if (code) {
    await answerChallenge(code);
  } else {
    showPairForm();
  }
}

async function answerChallenge(code) {
  const nonce = pendingChallenge;
  pendingChallenge = null;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(code),
      {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, nonce));
  const message = new Uint8Array(33);
  message[0] = TYPE_AUTH_RESPONSE;
  message.set(signature, 1);
  writeCode(code);
  socket.send(message);
}

function onAuthResult(result) {
  if (result === AUTH_OK) {
    authenticated = true;
    pairForm.hidden = true;
    showNotice('');
    canvas.focus();
    waitingForKey = true;
    resetClock();
    ping();
    pingTimer = setInterval(ping, PING_INTERVAL_MS);
    return;
  }
  writeCode(null);
  showPairForm(result === AUTH_LOCKED_OUT ? 'Too many wrong codes. Wait 30 seconds and try again.'
      : 'That code is wrong. Check the code your phone shows.');
}

// Two windows that both reconnected would keep throwing each other off, so the older one stays away.
function onReplaced() {
  sessionEnded = true;
  showNotice('This session is now open in another window. Reload this page to use it here.');
}

function onStatus(next) {
  status = next;
  if (canvas.width !== next.width || canvas.height !== next.height) {
    canvas.width = next.width;
    canvas.height = next.height;
  }
  if (!next.desktop) {
    showNotice('This phone did not make the display a desktop, so windows may not behave as expected.');
  } else {
    showNotice(next.usable ? '' : 'Your phone is locked. Unlock it to continue.');
  }
  if (!next.usable) {
    releaseHeldKeys();
  }
}

pairForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const code = normalizeCode(codeInput.value);
  if (!code || !pendingChallenge) {
    return;
  }
  pairForm.hidden = true;
  answerChallenge(code);
});

// ---- Clock ----

function nowUs() {
  return performance.now() * 1000;
}

function ping() {
  const buffer = new ArrayBuffer(9);
  const view = new DataView(buffer);
  view.setUint8(0, TYPE_PING);
  view.setFloat64(1, nowUs());
  send(buffer);
}

function resetClock() {
  clockSamples.length = 0;
  clockOffsetUs = null;
}

function onPong(view) {
  const sentUs = view.getFloat64(1);
  const serverUs = Number(view.getBigInt64(9));
  const receivedUs = nowUs();
  clockSamples.push({rtt: receivedUs - sentUs, offset: serverUs - (sentUs + receivedUs) / 2});
  if (clockSamples.length > CLOCK_SAMPLES) {
    clockSamples.shift();
  }
  // The sample with the shortest round trip has the least queueing, so it is the most accurate.
  clockOffsetUs = clockSamples.reduce((best, s) => (s.rtt < best.rtt ? s : best)).offset;
}

// ---- Video ----

function codecFromConfig(config) {
  // SPS NAL: start code, header byte, then profile, constraints and level.
  const start = config[2] === 1 ? 3 : 4;
  const hex = (b) => b.toString(16).padStart(2, '0');
  return `avc1.${hex(config[start + 1])}${hex(config[start + 2])}${hex(config[start + 3])}`;
}

function createDecoder() {
  if (decoder && decoder.state !== 'closed') {
    decoder.close();
  }
  decoder = new VideoDecoder({output: onDecoded, error: onDecodeError});
  decoder.configure({codec: codecString, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware'});
  frameMeta.clear();
  waitingForKey = true;
}

function onDecodeError(error) {
  console.warn('decoder error', error);
  requestKeyFrame();
  createDecoder();
}

function requestKeyFrame() {
  send(new Uint8Array([TYPE_KEY_FRAME]));
}

function onVideo(view, buffer) {
  const flags = view.getUint8(1);
  const captureUs = Number(view.getBigInt64(2));
  const encodedUs = Number(view.getBigInt64(10));
  const sentUs = Number(view.getBigInt64(18));
  const data = new Uint8Array(buffer, VIDEO_HEADER_BYTES);
  second.bytes += buffer.byteLength;
  measure.bytes += buffer.byteLength;

  if (flags & FLAG_CONFIG) {
    configBytes = data.slice();
    const next = codecFromConfig(configBytes);
    if (next !== codecString || !decoder || decoder.state === 'closed') {
      codecString = next;
      createDecoder();
    }
    return;
  }
  if (!decoder || decoder.state !== 'configured') {
    return;
  }
  const key = (flags & FLAG_KEY) !== 0;
  if (waitingForKey && !key) {
    return;
  }
  if (decoder.decodeQueueSize > MAX_DECODE_QUEUE) {
    // Falling behind. Skip to a key frame instead of showing ever older video.
    waitingForKey = true;
    requestKeyFrame();
    return;
  }
  waitingForKey = false;

  let payload = data;
  if (key) {
    // Without a codec description, WebCodecs needs the parameter sets inline on key frames.
    payload = new Uint8Array(configBytes.length + data.length);
    payload.set(configBytes);
    payload.set(data, configBytes.length);
  }
  frameMeta.set(captureUs, {encodedUs, sentUs, receivedUs: nowUs()});
  if (frameMeta.size > 240) {
    frameMeta.clear();
  }
  decoder.decode(new EncodedVideoChunk({type: key ? 'key' : 'delta', timestamp: captureUs, data: payload}));
}

function onDecoded(frame) {
  const decodedUs = nowUs();
  context.drawImage(frame, 0, 0, canvas.width, canvas.height);
  second.frames++;

  const meta = frameMeta.get(frame.timestamp);
  frameMeta.delete(frame.timestamp);
  if (meta && clockOffsetUs !== null) {
    const latency = decodedUs - (frame.timestamp - clockOffsetUs);
    second.latencyTotal += latency;
    second.latencyCount++;
    if (measure.active) {
      measure.record(frame.timestamp, meta, decodedUs, latency);
    }
  }
  if (measure.active) {
    measure.probe(frame, decodedUs);
  }
  frame.close();
}

setInterval(() => {
  const mbit = (second.bytes * 8 / 1e6).toFixed(1);
  const latency = second.latencyCount ? `${(second.latencyTotal / second.latencyCount / 1000).toFixed(0)} ms` : '–';
  hud.textContent = `${second.frames} fps · ${mbit} Mbit/s · ${latency}`;
  second.frames = 0;
  second.bytes = 0;
  second.latencyTotal = 0;
  second.latencyCount = 0;
}, 1000);

// ---- Input ----

function toDisplay(event) {
  // The canvas uses object-fit: contain, so work out where the picture actually sits.
  const box = canvas.getBoundingClientRect();
  const scale = Math.min(box.width / canvas.width, box.height / canvas.height);
  const left = box.left + (box.width - canvas.width * scale) / 2;
  const top = box.top + (box.height - canvas.height * scale) / 2;
  return [Math.round((event.clientX - left) / scale), Math.round((event.clientY - top) / scale)];
}

function sendMouse(action, button, x, y) {
  const buffer = new ArrayBuffer(11);
  const view = new DataView(buffer);
  view.setUint8(0, TYPE_MOUSE);
  view.setUint8(1, action);
  view.setUint8(2, button);
  view.setInt32(3, x);
  view.setInt32(7, y);
  send(buffer);
}

function sendScroll(x, y, horizontal, vertical) {
  const buffer = new ArrayBuffer(17);
  const view = new DataView(buffer);
  view.setUint8(0, TYPE_SCROLL);
  view.setInt32(1, x);
  view.setInt32(5, y);
  view.setFloat32(9, horizontal);
  view.setFloat32(13, vertical);
  send(buffer);
}

function sendKey(action, code, meta) {
  const buffer = new ArrayBuffer(10);
  const view = new DataView(buffer);
  view.setUint8(0, TYPE_KEY);
  view.setUint8(1, action);
  view.setInt32(2, code);
  view.setInt32(6, meta);
  send(buffer);
}

function metaState(event) {
  let meta = 0;
  if (event.shiftKey) {
    meta |= META_SHIFT;
  }
  if (event.altKey) {
    meta |= META_ALT;
  }
  if (isMac) {
    if (event.metaKey) {
      meta |= META_CTRL;
    }
    if (event.ctrlKey) {
      meta |= META_SYSTEM;
    }
  } else {
    if (event.ctrlKey) {
      meta |= META_CTRL;
    }
    if (event.metaKey) {
      meta |= META_SYSTEM;
    }
  }
  return meta;
}

function releaseHeldKeys() {
  for (const code of heldKeys) {
    sendKey(KEY_UP, code, 0);
  }
  heldKeys.clear();
}

function syncButtons(buttons) {
  const [x, y] = pointerAt;
  for (const bit of MOUSE_BUTTON_BITS) {
    if ((heldButtons ^ buttons) & bit) {
      sendMouse(buttons & bit ? MOUSE_PRESS : MOUSE_RELEASE, bit, x, y);
    }
  }
  heldButtons = buttons;
}

function releaseHeldButtons() {
  syncButtons(0);
}

function onPointerMove(event) {
  pointerAt = toDisplay(event);
  sendMouse(MOUSE_MOVE, 0, pointerAt[0], pointerAt[1]);
}

// pointerrawupdate fires without waiting for the next frame, which trims input latency where it exists.
canvas.addEventListener('onpointerrawupdate' in window ? 'pointerrawupdate' : 'pointermove', onPointerMove);

// Browsers report a second button pressed or released during a drag as a move with a button set.
canvas.addEventListener('pointermove', (event) => {
  if (event.button !== -1) {
    pointerAt = toDisplay(event);
    syncButtons(event.buttons);
  }
});

canvas.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  canvas.focus();
  pointerAt = toDisplay(event);
  syncButtons(event.buttons);
  canvas.setPointerCapture(event.pointerId);
});

canvas.addEventListener('pointerup', (event) => {
  event.preventDefault();
  pointerAt = toDisplay(event);
  syncButtons(event.buttons);
});

// Without these, a drag the browser gives up on would leave the button held down on the phone.
canvas.addEventListener('pointercancel', releaseHeldButtons);
canvas.addEventListener('lostpointercapture', releaseHeldButtons);

canvas.addEventListener('contextmenu', (event) => event.preventDefault());

canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  const [x, y] = toDisplay(event);
  const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 3 : 100;
  sendScroll(x, y, event.deltaX / unit, -event.deltaY / unit);
}, {passive: false});

window.addEventListener('keydown', (event) => {
  if (event.target === codeInput) {
    return;
  }
  const code = KEYCODES[event.code];
  if (code === undefined) {
    return;
  }
  event.preventDefault();
  heldKeys.add(code);
  sendKey(KEY_DOWN, code, metaState(event));
});

window.addEventListener('keyup', (event) => {
  const code = KEYCODES[event.code];
  if (code === undefined || !heldKeys.has(code)) {
    return;
  }
  event.preventDefault();
  heldKeys.delete(code);
  sendKey(KEY_UP, code, metaState(event));
});

// A key or button released while the window is in the background would otherwise stay down on the phone.
window.addEventListener('blur', () => {
  releaseHeldKeys();
  releaseHeldButtons();
});

document.getElementById('fullscreen').addEventListener('click', async () => {
  if (document.fullscreenElement) {
    await document.exitFullscreen();
    return;
  }
  await document.documentElement.requestFullscreen();
  if (navigator.keyboard && navigator.keyboard.lock) {
    // Lets Esc and browser shortcuts reach the phone while fullscreen, where the browser allows it.
    await navigator.keyboard.lock();
  }
  canvas.focus();
});

document.getElementById('end').addEventListener('click', () => {
  sessionEnded = true;
  send(new Uint8Array([TYPE_STOP]));
  showNotice('Session ended. You can close this window.');
});

// ---- Measurement. Used by tools/measure.mjs, not by normal use. ----

const measure = {
  active: false,
  bytes: 0,
  frames: 0,
  distinct: 0,
  latencies: {captureToEncoded: [], encodedToSent: [], sentToReceived: [], receivedToDecoded: [], total: []},
  probeContext: null,
  previous: null,
  waiter: null,

  start() {
    this.active = true;
    this.bytes = 0;
    this.frames = 0;
    this.distinct = 0;
    for (const key of Object.keys(this.latencies)) {
      this.latencies[key] = [];
    }
    if (!this.probeContext) {
      this.probeContext = new OffscreenCanvas(PROBE_WIDTH, PROBE_HEIGHT).getContext('2d', {willReadFrequently: true});
    }
  },

  record(captureUs, meta, decodedUs, total) {
    const sentLocalUs = meta.sentUs - clockOffsetUs;
    this.latencies.captureToEncoded.push(meta.encodedUs - captureUs);
    this.latencies.encodedToSent.push(meta.sentUs - meta.encodedUs);
    this.latencies.sentToReceived.push(meta.receivedUs - sentLocalUs);
    this.latencies.receivedToDecoded.push(decodedUs - meta.receivedUs);
    this.latencies.total.push(total);
  },

  probe(frame, decodedUs) {
    this.frames++;
    this.probeContext.drawImage(frame, 0, 0, PROBE_WIDTH, PROBE_HEIGHT);
    const pixels = this.probeContext.getImageData(0, 0, PROBE_WIDTH, PROBE_HEIGHT).data;
    let changed = 0;
    if (this.previous) {
      for (let i = 1; i < pixels.length; i += 4) {
        if (Math.abs(pixels[i] - this.previous[i]) > PROBE_CHANGE_LEVEL) {
          changed++;
        }
      }
    }
    this.previous = pixels;
    if (changed >= PROBE_CHANGED_CELLS) {
      this.distinct++;
      if (this.waiter) {
        const resolve = this.waiter;
        this.waiter = null;
        resolve(decodedUs);
      }
    }
  },

  waitForChange(timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        resolve(null);
      }, timeoutMs);
      this.waiter = (time) => {
        clearTimeout(timer);
        resolve(time);
      };
    });
  },
};

function percentiles(values) {
  if (!values.length) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] / 100) / 10;
  return {p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1), count: sorted.length};
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function click(x, y) {
  sendMouse(MOUSE_MOVE, 0, x, y);
  sendMouse(MOUSE_PRESS, 1, x, y);
  sendMouse(MOUSE_RELEASE, 1, x, y);
}

// Time from sending a click to the first decoded frame that looks different.
async function measureClicks({targets, count = 30, settleMs = 900, timeoutMs = 2000}) {
  measure.start();
  const samples = [];
  let missed = 0;
  for (let i = 0; i < count; i++) {
    await sleep(settleMs);
    const [x, y] = targets[i % targets.length];
    const sentUs = nowUs();
    const change = measure.waitForChange(timeoutMs);
    click(x, y);
    const changedUs = await change;
    if (changedUs === null) {
      missed++;
    } else {
      samples.push(changedUs - sentUs);
    }
  }
  measure.active = false;
  return {clickToChange: percentiles(samples), missed};
}

// Drags a window in a circle, which makes the desktop redraw constantly.
async function measureDrag({seconds, start, radius = 150}) {
  measure.start();
  const [cx, cy] = start;
  sendMouse(MOUSE_MOVE, 0, cx, cy);
  sendMouse(MOUSE_PRESS, 1, cx, cy);
  const startedAt = performance.now();
  const end = startedAt + seconds * 1000;
  while (performance.now() < end) {
    const angle = (performance.now() - startedAt) / 1000 * 2;
    sendMouse(MOUSE_MOVE, 0, Math.round(cx + radius * (Math.cos(angle) - 1)), Math.round(cy + radius * Math.sin(angle)));
    await sleep(16);
  }
  sendMouse(MOUSE_MOVE, 0, cx, cy);
  sendMouse(MOUSE_RELEASE, 1, cx, cy);
  const elapsed = (performance.now() - startedAt) / 1000;
  measure.active = false;
  const summary = {};
  for (const [key, values] of Object.entries(measure.latencies)) {
    summary[key] = percentiles(values);
  }
  return {
    seconds: Math.round(elapsed),
    decodedFps: Math.round(measure.frames / elapsed * 10) / 10,
    distinctFps: Math.round(measure.distinct / elapsed * 10) / 10,
    megabitsPerSecond: Math.round(measure.bytes * 8 / elapsed / 1e5) / 10,
    droppedFrames: status ? status.dropped : null,
    latencyMs: summary,
  };
}

window.shinonome = {
  getStatus: () => status,
  isConnected: () => authenticated,
  measureClicks,
  measureDrag,
};

// ---- Start ----

function start() {
  if (!window.isSecureContext || !window.VideoDecoder) {
    showNotice('This browser cannot decode the video here. Use a current version of Chrome, Edge, Safari or Firefox over https.');
    return;
  }
  // A code in the URL fragment never reaches the network, which suits pairing links.
  const fragment = new URLSearchParams(location.hash.slice(1)).get('code');
  if (fragment) {
    writeCode(normalizeCode(fragment));
    history.replaceState(null, '', location.pathname);
  }
  connect();
}

start();
