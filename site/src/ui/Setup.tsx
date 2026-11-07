import { useEffect, useState, type ReactNode } from 'react';
import { isUsbAvailable } from '../adb/usb';
import { APK_PATH, RELEASES_URL } from '../shinonome/constants';
import type { Controller, ShinonomeState, Step } from '../shinonome/controller';

const STEPS: Step[] = ['phone', 'app', 'start'];

interface Props {
  controller: Controller;
  state: ShinonomeState;
}

function appSummary(state: ShinonomeState): string | null {
  if (state.appCurrent) {
    return `Shinonome ${state.app?.versionName ?? ''}`;
  }
  return state.appSkipped ? 'Skipped' : null;
}

export function Setup({ controller, state }: Props) {
  const current = STEPS.indexOf(state.step);
  return (
    <main className="setup">
      <section className="hero">
        <h1>Use your Pixel's desktop in this browser</h1>
        <p>
          Plug your phone into this computer and its desktop opens right here, with a taskbar and real windows. There's
          nothing to install on this computer, and no monitor or root needed.
        </p>
      </section>
      <ol className="steps">
        <StepCard number={1} title="Connect your phone" done={current > 0} active={current === 0} summary={state.phone}>
          <PhoneStep controller={controller} state={state} />
        </StepCard>
        <StepCard number={2} title="Install the app" optional done={current > 1} active={current === 1} summary={appSummary(state)}>
          <AppStep controller={controller} state={state} />
        </StepCard>
        <StepCard number={3} title="Start the desktop" done={false} active={current === 2} summary={null}>
          <StartStep controller={controller} state={state} />
        </StepCard>
      </ol>
      {state.notice ? (
        <div className="notice-banner" role="status">
          <mdui-icon-check />
          <span>{state.notice}</span>
          <mdui-button-icon onClick={() => controller.dismissNotice()} aria-label="Dismiss">
            <mdui-icon-close />
          </mdui-button-icon>
        </div>
      ) : null}
      {state.error ? (
        <div className="error-banner" role="alert">
          <mdui-icon-error-outline />
          <span>{state.error}</span>
          <mdui-button-icon onClick={() => controller.dismissError()} aria-label="Dismiss">
            <mdui-icon-close />
          </mdui-button-icon>
        </div>
      ) : null}
      <footer className="setup-footer">
        Only use this page from an address you trust. It can do anything adb can on the phone you connect, and while a
        session runs, this window can use your apps without your PIN.
      </footer>
    </main>
  );
}

interface StepCardProps {
  number: number;
  title: string;
  optional?: boolean;
  done: boolean;
  active: boolean;
  summary: string | null;
  children: ReactNode;
}

function StepCard({ number, title, optional, done, active, summary, children }: StepCardProps) {
  return (
    <li className={`step ${active ? 'step-active' : ''} ${done ? 'step-done' : ''}`}>
      <div className="step-head">
        <span className="step-badge" aria-hidden="true">
          {done ? <mdui-icon-check /> : number}
        </span>
        <span className="step-title">{title}</span>
        {optional && !done ? <span className="step-optional">Optional</span> : null}
        {done && summary ? <span className="step-summary">{summary}</span> : null}
      </div>
      {active ? <div className="step-body">{children}</div> : null}
    </li>
  );
}

function PhoneStep({ controller, state }: Props) {
  return (
    <>
      <p>
        Turn on <strong>USB debugging</strong> in Developer options on your phone, and plug it in with a cable that carries
        data. Your computer doesn't need adb or anything else.
      </p>
      {state.busy ? (
        <Waiting text={state.busy} />
      ) : isUsbAvailable ? (
        <div className="actions">
          <mdui-button id="connect-phone" variant="filled" onClick={() => void controller.connectUsb()}>
            <mdui-icon-usb slot="icon" />
            Connect phone
          </mdui-button>
        </div>
      ) : (
        <p className="note">
          This browser can't use USB. Chrome, Edge and other Chromium browsers can, on a computer. Safari and Firefox don't
          have WebUSB.
        </p>
      )}
      {import.meta.env.DEV && !state.busy ? <DevDevices controller={controller} /> : null}
    </>
  );
}

/** Emulators have no USB, so in development the page can also find devices through the adb server. */
function DevDevices({ controller }: { controller: Controller }) {
  const [devices, setDevices] = useState<import('../adb/dev-server').DevDevice[]>([]);
  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const { listDevDevices } = await import('../adb/dev-server');
        const found = await listDevDevices();
        if (!stopped) {
          setDevices(found);
        }
      } catch (error) {
        console.info('no adb server to list devices from', error);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);
  if (devices.length === 0) {
    return null;
  }
  return (
    <div className="dev-devices">
      <span className="note">From the adb server (development only):</span>
      <div className="actions">
        {devices.map((device) => (
          <mdui-button key={device.serial} id={`dev-${device.serial}`} variant="tonal" onClick={() => void controller.connectThroughAdbServer(device)}>
            {device.label}
          </mdui-button>
        ))}
      </div>
    </div>
  );
}

function AppStep({ controller, state }: Props) {
  const outdated = state.app?.installed && !state.appCurrent;
  const verb = outdated ? 'Update' : 'Install';
  if (state.installing) {
    return (
      <>
        <p>
          {state.installProgress < 1
            ? `Sending Shinonome ${__SHINONOME_VERSION__} to your phone.`
            : 'Your phone is installing it. If it asks you to confirm, allow it there.'}
        </p>
        <mdui-linear-progress value={state.installProgress < 1 ? state.installProgress : undefined} max={1} />
      </>
    );
  }
  if (state.installManually) {
    return (
      <>
        <p>Install the APK on your phone however you like. This page carries on by itself when it sees the app.</p>
        <div className="actions">
          <mdui-button variant="tonal" href={APK_PATH} download={APK_PATH}>
            <mdui-icon-download slot="icon" />
            Download APK
          </mdui-button>
          <mdui-button variant="text" href={RELEASES_URL} target="_blank" rel="noreferrer">
            All releases
          </mdui-button>
          <mdui-button variant="text" onClick={() => controller.cancelManualInstall()}>
            Back
          </mdui-button>
        </div>
        <Waiting text="Waiting for the app to appear on your phone." />
      </>
    );
  }
  return (
    <>
      <p>
        {outdated ? `Your phone has Shinonome ${state.app?.versionName ?? ''}, and this page has ${__SHINONOME_VERSION__}. ` : ''}
        You don't need the app for the desktop in this browser. It adds the desktop on your phone's own screen, and lets you
        start a session from the phone.
      </p>
      <div className="actions">
        {state.offerUninstall ? (
          <mdui-button id="reinstall-app" variant="filled" onClick={() => void controller.uninstallAndInstall()}>
            Remove and reinstall
          </mdui-button>
        ) : (
          <mdui-button id="install-app" variant="filled" onClick={() => void controller.installApp()}>
            <mdui-icon-install-mobile slot="icon" />
            {verb} it for me
          </mdui-button>
        )}
        <mdui-button id="install-manually" variant="outlined" onClick={() => void controller.installManually()}>
          I'll {verb.toLowerCase()} it myself
        </mdui-button>
        <mdui-button id="skip-app" variant="text" onClick={() => controller.skipApp()}>
          Skip for now
        </mdui-button>
      </div>
    </>
  );
}

function StartStep({ controller, state }: Props) {
  if (state.busy) {
    return <Waiting text={state.busy} />;
  }
  if (state.startingOnPhone) {
    return (
      <>
        <p>
          Shinonome is open on your phone. Tap <strong>Start session</strong> there, which needs Shizuku running. This page
          joins in by itself.
        </p>
        <div className="actions">
          <mdui-button variant="text" onClick={() => controller.cancelStartOnPhone()}>
            Back
          </mdui-button>
        </div>
        <Waiting text="Waiting for your phone." />
      </>
    );
  }
  return (
    <>
      <p>Your phone's screen turns off while you work here, and you might need to unlock it once to begin.</p>
      <div className="actions">
        <mdui-button id="start-for-me" variant="filled" onClick={() => void controller.startForMe()}>
          <mdui-icon-power-settings-new slot="icon" />
          Start it for me
        </mdui-button>
        {state.appCurrent ? (
          <mdui-button id="start-on-phone" variant="outlined" onClick={() => void controller.startOnPhone()}>
            <mdui-icon-phone-android slot="icon" />
            I'll start it on my phone
          </mdui-button>
        ) : (
          <mdui-button id="show-app-step" variant="text" onClick={() => controller.showAppStep()}>
            <mdui-icon-install-mobile slot="icon" />
            {state.app?.installed ? 'Update the app' : 'Install the app'}
          </mdui-button>
        )}
      </div>
    </>
  );
}

function Waiting({ text }: { text: string }) {
  return (
    <div className="waiting" role="status">
      <mdui-circular-progress />
      <span>{text}</span>
    </div>
  );
}
