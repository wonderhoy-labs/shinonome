// Connects this page to the phone over a USB cable, with no adb or anything else on the computer.
//
// WebUSB reaches adbd on the phone, adbd reaches Shinonome's server on a local socket, and client.js
// does the rest exactly as it does over Wi-Fi. This file is the transport client.js picks up.
import { Adb, AdbDaemonTransport } from '@yume-chan/adb';
import AdbWebCredentialStore from '@yume-chan/adb-credential-web';
import { AdbDaemonWebUsbDevice, AdbDaemonWebUsbDeviceManager } from '@yume-chan/adb-daemon-webusb';

const DIR = '/data/local/tmp/shinonome';
const SERVER_PATH = `${DIR}/usb-server.apk`;
const SCRIPT_PATH = `${DIR}/start.sh`;
const USB_SOCKET = 'localabstract:shinonome';
// Must match USB_PROTOCOL in Server.java. A server with another number gets replaced by the one here.
const USB_PROTOCOL = 1;
const FILE_MODE = 0o600;
// How much video may be on its way before the browser has read it. Anything queued is old by the time
// it's shown, and the server can only skip ahead when this fills up.
const VIDEO_WINDOW_BYTES = 512 * 1024;
const LENGTH_BYTES = 4;
const INITIAL_BUFFER_BYTES = 1024 * 1024;
const RELEASE_DELAY_MS = 500;

const card = document.getElementById('usb');
const cardTitle = document.getElementById('usb-title');
const cardText = document.getElementById('usb-text');
const cardButton = document.getElementById('usb-button');
const bar = document.getElementById('bar');

const manager = AdbDaemonWebUsbDeviceManager.BROWSER;

let adb = null;
let writer = null;
let hasOpened = false;

/** A problem to show as written, because there is nothing more useful to add to it. */
class ShownError extends Error {}

function showCard(title, text, buttonLabel) {
  cardTitle.textContent = title;
  cardText.textContent = text;
  cardButton.hidden = !buttonLabel;
  cardButton.textContent = buttonLabel || '';
  card.hidden = false;
  bar.hidden = true;
}

function hideCard() {
  card.hidden = true;
  bar.hidden = false;
}

function clickOnCard(title, text, buttonLabel) {
  showCard(title, text, buttonLabel);
  return new Promise((resolve) => {
    cardButton.addEventListener('click', () => resolve(), {once: true});
  });
}

// Resolves with whether it was the button, because only a click allows asking the browser for a device.
function waitForPhone() {
  showCard('Connect your phone',
      'Plug it in with a USB cable. USB debugging has to be on, in Developer options.', 'Connect phone');
  return new Promise((resolve) => {
    const onPlugged = () => finish(false);
    const onClicked = () => finish(true);
    function finish(clicked) {
      navigator.usb.removeEventListener('connect', onPlugged);
      cardButton.removeEventListener('click', onClicked);
      resolve(clicked);
    }
    navigator.usb.addEventListener('connect', onPlugged);
    cardButton.addEventListener('click', onClicked);
  });
}

async function findDevice(clicked) {
  while (true) {
    const devices = await manager.getDevices();
    if (devices.length === 1) {
      return devices[0];
    }
    if (clicked) {
      const device = await manager.requestDevice();
      if (device) {
        return device;
      }
    }
    clicked = await waitForPhone();
  }
}

async function connectAdb(device) {
  showCard('Check your phone', 'Unlock it. If it asks whether to allow USB debugging, tap Allow.');
  const transport = await AdbDaemonTransport.authenticate({
    serial: device.serial,
    connection: await device.connect(),
    credentialStore: new AdbWebCredentialStore('Shinonome'),
    initialDelayedAckBytes: VIDEO_WINDOW_BYTES,
  });
  const connected = new Adb(transport);
  const forget = (reason) => {
    console.info('adb disconnected', reason);
    if (adb === connected) {
      adb = null;
    }
  };
  connected.disconnected.then(forget, forget);
  return connected;
}

function shell(command) {
  return adb.subprocess.noneProtocol.spawnWaitText(command);
}

// By reading the log of a running server, rather than just trying the socket, because any app on the
// phone could be listening on that name. The server can only log this if it holds the name itself.
async function isServerRunning() {
  const log = await shell(`pidof shinonome-server >/dev/null && cat ${DIR}/server.log`);
  const lines = log.split('\n');
  return lines.includes(`usb protocol: ${USB_PROTOCOL}`) && lines.includes('listening');
}

async function fetchFile(name) {
  const response = await fetch(name);
  if (!response.ok) {
    throw new ShownError(`This site is missing ${name}.`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function pushFile(sync, path, bytes) {
  await sync.write({
    filename: path,
    permission: FILE_MODE,
    file: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  });
}

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Pushes the server from this site instead of using the app, so the two always match and the app
// doesn't have to be installed. A copy that's already there is left alone.
async function startServer() {
  showCard('Starting the desktop', 'This takes a few seconds.');
  const [apk, script] = await Promise.all([fetchFile('server.apk'), fetchFile('start.sh')]);
  const digest = toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', apk)));

  const existing = await shell(`umask 077; mkdir -p ${DIR}; chmod 700 ${DIR}; sha256sum ${SERVER_PATH} 2>/dev/null`);
  const sync = await adb.sync();
  try {
    if (!existing.startsWith(digest)) {
      await pushFile(sync, SERVER_PATH, apk);
    }
    await pushFile(sync, SCRIPT_PATH, script);
  } finally {
    await sync.dispose();
  }

  const output = await shell(`SHINONOME_APK=${SERVER_PATH} sh ${SCRIPT_PATH} --no-network`);
  const incompatible = /^incompatible: (.*)$/m.exec(output);
  if (incompatible) {
    throw new ShownError(incompatible[1]);
  }
  if (!(await isServerRunning())) {
    throw new ShownError(`The desktop didn't start. The phone said:\n\n${output.trim().slice(-600)}`);
  }
}

// Every message arrives with its length in front, split across adb packets in any way.
async function readMessages(readable, onData) {
  let buffer = new Uint8Array(INITIAL_BUFFER_BYTES);
  let filled = 0;
  const reader = readable.getReader();
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) {
        return;
      }
      if (filled + value.length > buffer.length) {
        const bigger = new Uint8Array((filled + value.length) * 2);
        bigger.set(buffer.subarray(0, filled));
        buffer = bigger;
      }
      buffer.set(value, filled);
      filled += value.length;

      const view = new DataView(buffer.buffer);
      let offset = 0;
      while (filled - offset >= LENGTH_BYTES) {
        const length = view.getUint32(offset);
        if (filled - offset - LENGTH_BYTES < length) {
          break;
        }
        const start = offset + LENGTH_BYTES;
        onData(buffer.slice(start, start + length).buffer);
        offset = start + length;
      }
      buffer.copyWithin(0, offset, filled);
      filled -= offset;
    }
  } finally {
    reader.releaseLock();
  }
}

function explain(error) {
  if (error instanceof AdbDaemonWebUsbDevice.DeviceBusyError) {
    return 'Something else on this computer is using USB debugging. Close any other WebADB tabs, stop adb by ' +
        'running "adb kill-server", and quit Android Studio if it\'s open.';
  }
  if (error instanceof ShownError) {
    return error.message;
  }
  return `Couldn't reach your phone: ${error.message}`;
}

async function closeAdb() {
  const closing = adb;
  adb = null;
  if (closing) {
    try {
      await closing.close();
    } catch (error) {
      console.warn('closing adb failed', error);
    }
  }
}

// Only a click starts a session. After a lost link this reattaches to a running session by itself, but
// a session that has ended, say from the app on the phone, stays ended until someone asks again.
async function open(onData, onEnd) {
  if (!manager) {
    showCard('This browser can\'t use USB',
        'This page needs WebUSB, which Chrome, Edge and other Chromium browsers have. Safari and Firefox don\'t.');
    return;
  }
  let clicked = false;
  if (!hasOpened) {
    hasOpened = true;
    await clickOnCard('Connect your phone',
        'Plug it in with a USB cable. USB debugging has to be on, in Developer options. This page talks to the ' +
        'phone directly, and nothing goes through a server.', 'Connect phone');
    clicked = true;
  }
  while (true) {
    try {
      if (!adb) {
        adb = await connectAdb(await findDevice(clicked));
      }
      if (!(await isServerRunning())) {
        if (!clicked) {
          await clickOnCard('Session ended', 'Start a new one whenever you\'re ready.', 'Start desktop');
          clicked = true;
        }
        await startServer();
      }
      const socket = await adb.createSocket(USB_SOCKET);
      writer = socket.writable.getWriter();
      hideCard();
      readMessages(socket.readable, onData).catch((error) => {
        console.warn('lost the phone', error);
      }).finally(() => {
        writer = null;
        onEnd();
      });
      return;
    } catch (error) {
      console.warn(error);
      await closeAdb();
      await clickOnCard('That didn\'t work', explain(error), 'Try again');
      clicked = true;
    }
  }
}

function send(buffer) {
  if (!writer) {
    return;
  }
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const framed = new Uint8Array(LENGTH_BYTES + bytes.length);
  new DataView(framed.buffer).setUint32(0, bytes.length);
  framed.set(bytes, LENGTH_BYTES);
  // A lost link shows up on the reading side, which reconnects.
  writer.write(framed).catch(() => {});
}

window.shinonomeTransport = {
  open,
  send,
  // Hands USB back after a session ends, so adb and other tools can use the phone again.
  release() {
    setTimeout(closeAdb, RELEASE_DELAY_MS);
  },
  // For tools/measure.mjs, which has no other way into the phone while this page holds USB.
  shell,
};
