import type { AdbSocket } from '@yume-chan/adb';
import type { AdbDaemonWebUsbDevice } from '@yume-chan/adb-daemon-webusb';
import startScript from '../../../app/src/main/assets/start.sh?raw';
import { frameMessage, FrameReader } from '../adb/frames';
import { InstallError, type AppInfo, type Phone } from '../adb/phone';
import { knownPhone, openUsbPhone, pickPhone, UsbBusyError } from '../adb/usb';
import { exposeDebugApi } from '../session/debug';
import { DesktopSession, type SessionStats } from '../session/desktop-session';
import type { DesktopStatus } from '../session/protocol';
import { APK_PATH } from './constants';

export type Step = 'phone' | 'app' | 'start' | 'live';
export type LinkState = 'connecting' | 'up' | 'phone-lost';

export interface ShinonomeState {
  step: Step;
  /** The phone's name once it's attached. */
  phone: string | null;
  app: AppInfo | null;
  /** True if the app's version is what this site carries, or newer. */
  appCurrent: boolean;
  /** Someone chose to go without this site's version of the app. */
  appSkipped: boolean;
  installing: boolean;
  installProgress: number;
  installManually: boolean;
  /** The install failed in a way that only removing the old copy can fix. */
  offerUninstall: boolean;
  /** What to tell the person while something's happening. */
  busy: string | null;
  /** Waiting for someone to tap Start session in the app. */
  startingOnPhone: boolean;
  error: string | null;
  notice: string | null;

  link: LinkState;
  status: DesktopStatus | null;
  stats: SessionStats | null;
  hasPicture: boolean;
}

const STORED_SKIPPED_VERSION = 'shinonome.skipped-app-version';
const POLL_MILLIS = 1_000;
const RECONNECT_MILLIS = 1_000;
// Unplugging ends the link too, and that's handled when adb notices, a moment later.
const LINK_SETTLE_MILLIS = 300;
// Long enough for the last message to reach the phone before USB closes.
const RELEASE_DELAY_MILLIS = 500;
// How long a phone takes to reset its USB after a browser holding it goes away without saying so.
const USB_RESET_MILLIS = 1_500;

function stored(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function store(key: string, value: string | null) {
  try {
    if (value === null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, value);
    }
  } catch {
    // Without storage it's just asked again next time.
  }
}

const sleep = (millis: number) => new Promise<void>((resolve) => setTimeout(resolve, millis));

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Everything the page does, step by step. The screens only show this and call its methods. */
export class Controller {
  private state: ShinonomeState = {
    step: 'phone',
    phone: null,
    app: null,
    appCurrent: false,
    appSkipped: Number(stored(STORED_SKIPPED_VERSION)) >= __SHINONOME_VERSION_CODE__,
    installing: false,
    installProgress: 0,
    installManually: false,
    offerUninstall: false,
    busy: null,
    startingOnPhone: false,
    error: null,
    notice: null,
    link: 'connecting',
    status: null,
    stats: null,
    hasPicture: false,
  };

  private readonly listeners = new Set<() => void>();
  private phone: Phone | null = null;
  private session: DesktopSession | null = null;
  private socket: AdbSocket | null = null;
  private apk: Uint8Array<ArrayBuffer> | null = null;
  private usingUsb = false;
  /** Bumped to cancel whatever long-running job is going on. Each one checks it's still current. */
  private job = 0;
  /** The same, for the connection to the desktop. */
  private linkJob = 0;

  constructor() {
    navigator.usb?.addEventListener('connect', () => void this.onUsbPlugged());
    window.addEventListener('pagehide', () => void this.phone?.close().catch(() => undefined));
    exposeDebugApi(() => this.session, (command) => this.requirePhone().shell(command));
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getState = () => this.state;

  private update(changes: Partial<ShinonomeState>) {
    this.state = { ...this.state, ...changes };
    for (const listener of this.listeners) {
      listener();
    }
  }

  dismissError() {
    this.update({ error: null });
  }

  dismissNotice() {
    this.update({ notice: null });
  }

  private requirePhone(): Phone {
    if (!this.phone) {
      throw new Error('The phone was disconnected.');
    }
    return this.phone;
  }

  // Step 1: the phone

  /** Has to be called straight from a click, because of the browser's list of devices. */
  async connectUsb() {
    this.update({ error: null, notice: null });
    try {
      const device = (await knownPhone()) ?? (await pickPhone());
      if (!device) {
        return;
      }
      this.usingUsb = true;
      await this.attachUsb(device);
    } catch (error) {
      this.update({ busy: null, error: `Couldn't reach your phone: ${message(error)}` });
    }
  }

  /** Tries once more if USB failed, because a phone resets it just after a browser crashes or is closed. */
  private async attachUsb(device: AdbDaemonWebUsbDevice) {
    try {
      await this.attach(() => openUsbPhone(device));
    } catch (error) {
      if (error instanceof UsbBusyError) {
        throw error;
      }
      console.info('retrying after a USB failure', error);
      await sleep(USB_RESET_MILLIS);
      const again = await knownPhone();
      if (!again) {
        throw error;
      }
      await this.attach(() => openUsbPhone(again));
    }
  }

  /** Development only: uses a phone or emulator through the adb server. */
  async connectThroughAdbServer(device: import('../adb/dev-server').DevDevice) {
    if (!import.meta.env.DEV) {
      return;
    }
    this.update({ error: null, notice: null });
    try {
      const { openDevPhone } = await import('../adb/dev-server');
      this.usingUsb = false;
      await this.attach(() => openDevPhone(device));
    } catch (error) {
      this.update({ busy: null, error: `Couldn't reach that device: ${message(error)}` });
    }
  }

  private async onUsbPlugged() {
    // Only to carry on after a replug. The first connection is always someone's click.
    if (!this.usingUsb || this.phone) {
      return;
    }
    try {
      const device = await knownPhone();
      if (device && !this.phone) {
        await this.attachUsb(device);
      }
    } catch (error) {
      this.update({ busy: null, error: `Couldn't reach your phone: ${message(error)}` });
    }
  }

  private async attach(open: () => Promise<Phone>) {
    this.update({ busy: 'Unlock your phone. If it asks whether to allow USB debugging, tap Allow.' });
    const phone = await open();
    this.phone = phone;
    const lost = () => this.onPhoneLost(phone);
    phone.disconnected.then(lost, lost);
    this.update({ phone: phone.name, busy: null, error: null });

    let app: AppInfo;
    let serverRunning: boolean;
    try {
      app = await this.refreshApp();
      // A running session is picked straight back up, after a reload or a replug.
      serverRunning = await phone.isServerRunning();
    } catch (error) {
      this.phone = null;
      void phone.close().catch(() => undefined);
      throw error;
    }
    if (serverRunning) {
      this.enterDesktop();
      return;
    }
    if (this.state.step === 'live') {
      this.leaveDesktop('The session ended while your phone was unplugged.');
      return;
    }
    this.update({ step: this.stepAfterPhone(app) });
  }

  private onPhoneLost(phone: Phone) {
    if (this.phone !== phone) {
      return;
    }
    this.phone = null;
    this.job++;
    this.linkJob++;
    this.socket = null;
    this.session?.detach();
    if (this.state.step === 'live') {
      this.update({ phone: null, link: 'phone-lost' });
      return;
    }
    this.update({
      phone: null,
      step: 'phone',
      installing: false,
      installManually: false,
      startingOnPhone: false,
      busy: null,
    });
  }

  private appIsCurrent(app: AppInfo): boolean {
    return app.installed && (app.versionCode ?? 0) >= __SHINONOME_VERSION_CODE__;
  }

  private stepAfterPhone(app: AppInfo): Step {
    return this.appIsCurrent(app) || this.state.appSkipped ? 'start' : 'app';
  }

  private async refreshApp(): Promise<AppInfo> {
    const app = await this.requirePhone().appInfo();
    this.update({ app, appCurrent: this.appIsCurrent(app) });
    return app;
  }

  // Step 2: the app, which is optional because the desktop in this browser doesn't need it

  private async fetchApk(): Promise<Uint8Array<ArrayBuffer>> {
    if (!this.apk) {
      const response = await fetch(APK_PATH);
      if (!response.ok) {
        throw new Error(`This site is missing ${APK_PATH}.`);
      }
      this.apk = new Uint8Array(await response.arrayBuffer());
    }
    return this.apk;
  }

  async installApp() {
    this.update({ installing: true, installProgress: 0, installManually: false, offerUninstall: false, error: null, notice: null });
    try {
      const phone = this.requirePhone();
      await phone.install(await this.fetchApk(), (installProgress) => this.update({ installProgress }));
      const app = await this.refreshApp();
      // A new app can't do anything until it's been opened once, and this shows it worked.
      await phone.openApp().catch((error: unknown) => console.warn("couldn't open the app", error));
      this.update({
        installing: false,
        step: this.stepAfterPhone(app),
        notice: `Shinonome ${app.versionName ?? ''} is installed and open on your phone.`,
      });
    } catch (error) {
      const uninstall = error instanceof InstallError && error.needsUninstall;
      this.update({
        installing: false,
        offerUninstall: uninstall,
        error: uninstall
          ? "The copy of Shinonome on your phone was signed with a different key, or is newer, so Android won't replace it. Removing it also clears its Shizuku permission."
          : `Couldn't install the app: ${message(error)}`,
      });
    }
  }

  async uninstallAndInstall() {
    try {
      await this.requirePhone().uninstall();
      await this.installApp();
    } catch (error) {
      this.update({ error: `Couldn't remove the old app: ${message(error)}` });
    }
  }

  /** Waits for someone to install it by hand, and carries on when it appears. */
  async installManually() {
    const job = ++this.job;
    this.update({ installManually: true, error: null, notice: null });
    try {
      while (this.job === job && this.phone) {
        const app = await this.refreshApp();
        if (this.appIsCurrent(app)) {
          this.update({ installManually: false, step: this.stepAfterPhone(app) });
          return;
        }
        await sleep(POLL_MILLIS);
      }
    } catch (error) {
      if (this.job === job) {
        this.update({ installManually: false, error: message(error) });
      }
    }
  }

  cancelManualInstall() {
    this.job++;
    this.update({ installManually: false });
  }

  /** Remembered, and asked again when this site carries a newer version. */
  skipApp() {
    store(STORED_SKIPPED_VERSION, String(__SHINONOME_VERSION_CODE__));
    this.job++;
    this.update({ appSkipped: true, step: 'start', installManually: false, offerUninstall: false, error: null, notice: null });
  }

  showAppStep() {
    store(STORED_SKIPPED_VERSION, null);
    this.update({ appSkipped: false, step: 'app', error: null, notice: null });
  }

  // Step 3: starting the desktop

  async startForMe() {
    this.update({ busy: 'Starting the desktop. This takes a few seconds.', error: null, notice: null });
    try {
      const phone = this.requirePhone();
      const output = await phone.startServer(await this.fetchApk(), startScript);
      const incompatible = /^incompatible: (.*)$/m.exec(output)?.[1];
      if (incompatible) {
        throw new Error(incompatible);
      }
      if (!(await phone.isServerRunning())) {
        throw new Error(`The desktop didn't start. The phone said:\n\n${output.trim().slice(-600)}`);
      }
      this.update({ busy: null });
      this.enterDesktop();
    } catch (error) {
      this.update({ busy: null, error: message(error) });
    }
  }

  /** Opens the app and waits for someone to tap Start session in it. */
  async startOnPhone() {
    const job = ++this.job;
    this.update({ startingOnPhone: true, error: null, notice: null });
    try {
      const phone = this.requirePhone();
      await phone.openApp();
      while (this.job === job && this.phone) {
        if (await phone.isServerRunning()) {
          this.update({ startingOnPhone: false });
          this.enterDesktop();
          return;
        }
        await sleep(POLL_MILLIS);
      }
    } catch (error) {
      if (this.job === job) {
        this.update({ startingOnPhone: false, error: message(error) });
      }
    }
  }

  cancelStartOnPhone() {
    this.job++;
    this.update({ startingOnPhone: false });
  }

  // The desktop

  private enterDesktop() {
    if (this.state.step === 'live') {
      void this.openLink();
      return;
    }
    this.update({ step: 'live', link: 'connecting', status: null, stats: null, hasPicture: false, error: null });
  }

  private leaveDesktop(notice: string) {
    this.linkJob++;
    this.socket = null;
    this.update({ step: this.phone ? 'start' : 'phone', notice, status: null, stats: null, hasPicture: false });
  }

  /** The desktop screen hands over its canvas when it appears. */
  useCanvas(canvas: HTMLCanvasElement) {
    this.session?.dispose();
    this.session = new DesktopSession(canvas, {
      onStatus: (status) => this.update({ status }),
      onStats: (stats) => this.update({ stats }),
      onFirstFrame: () => this.update({ hasPicture: true }),
      onAuthenticated: () => this.update({ link: 'up' }),
      onReplaced: () => this.leaveDesktop('Another window took over this session. Start the desktop here to take it back.'),
    });
    void this.openLink();
  }

  releaseCanvas() {
    this.linkJob++;
    void this.socket?.close();
    this.socket = null;
    this.session?.dispose();
    this.session = null;
  }

  private async openLink() {
    const job = ++this.linkJob;
    const { phone, session } = this;
    if (!phone || !session) {
      return;
    }
    this.update({ link: 'connecting' });
    let socket: AdbSocket;
    try {
      socket = await phone.openDesktopSocket();
    } catch (error) {
      console.warn("couldn't open the desktop's socket", error);
      if (job === this.linkJob) {
        void this.onLinkEnded(phone);
      }
      return;
    }
    if (job !== this.linkJob) {
      void socket.close();
      return;
    }
    this.socket = socket;
    const writer = socket.writable.getWriter();
    // A lost link shows up on the reading side, which reconnects.
    session.attach((data) => void writer.write(frameMessage(data)).catch(() => undefined));

    const frames = new FrameReader();
    const reader = socket.readable.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        frames.push(value, (data) => {
          if (job === this.linkJob) {
            session.receive(data);
          }
        });
      }
    } catch (error) {
      console.info('the link to the phone ended', error);
    }
    if (job === this.linkJob) {
      session.detach();
      void this.onLinkEnded(phone);
    }
  }

  /** Reconnects to a session that's still running. One that's over stays over until someone asks again. */
  private async onLinkEnded(phone: Phone) {
    const job = this.linkJob;
    await sleep(LINK_SETTLE_MILLIS);
    if (job !== this.linkJob || this.phone !== phone) {
      return;
    }
    this.update({ link: 'connecting' });
    try {
      if (!(await phone.isServerRunning())) {
        if (job === this.linkJob) {
          this.leaveDesktop('The session ended.');
        }
        return;
      }
    } catch (error) {
      console.info('the phone went away while reconnecting', error);
      return;
    }
    await sleep(RECONNECT_MILLIS);
    if (job === this.linkJob && this.phone === phone) {
      void this.openLink();
    }
  }

  /** Ends the session, and hands USB back so adb and other tools can use the phone again. */
  endSession() {
    const phone = this.phone;
    const hadPhone = phone !== null;
    this.session?.stop();
    this.phone = null;
    this.linkJob++;
    this.job++;
    this.update({
      step: 'phone',
      phone: null,
      status: null,
      stats: null,
      hasPicture: false,
      notice: hadPhone
        ? 'Session ended. Your phone is free for adb and other tools again.'
        : "Your phone wasn't connected, so its session ends by itself after two minutes.",
    });
    setTimeout(() => void phone?.close().catch(() => undefined), RELEASE_DELAY_MILLIS);
  }
}
