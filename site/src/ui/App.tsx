import { useSyncExternalStore } from 'react';
import { REPO_URL } from '../shinonome/constants';
import { Controller } from '../shinonome/controller';
import { Desktop } from './Desktop';
import { Setup } from './Setup';

// Only one, because it listens for USB and page events for as long as the page is open.
const controller = new Controller();

export function App() {
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  if (state.step === 'live') {
    return <Desktop controller={controller} state={state} />;
  }
  return (
    <div className="app">
      <header className="app-bar">
        <img className="app-bar-logo" src="./logo.webp" alt="" />
        <span className="app-bar-title">Shinonome</span>
        <span className="app-bar-space" />
        <mdui-button variant="text" href={REPO_URL} target="_blank" rel="noreferrer">
          GitHub
          <mdui-icon-open-in-new slot="end-icon" />
        </mdui-button>
      </header>
      <Setup controller={controller} state={state} />
    </div>
  );
}
