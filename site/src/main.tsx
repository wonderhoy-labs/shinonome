import '@fontsource-variable/roboto-flex';
import 'mdui/mdui.css';
import 'mdui/components/button.js';
import 'mdui/components/button-icon.js';
import 'mdui/components/circular-progress.js';
import 'mdui/components/linear-progress.js';
import '@mdui/icons/check.js';
import '@mdui/icons/close.js';
import '@mdui/icons/download.js';
import '@mdui/icons/error-outline.js';
import '@mdui/icons/fullscreen.js';
import '@mdui/icons/install-mobile.js';
import '@mdui/icons/lock.js';
import '@mdui/icons/open-in-new.js';
import '@mdui/icons/phone-android.js';
import '@mdui/icons/power-settings-new.js';
import '@mdui/icons/usb.js';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './ui/theme.css';
import './ui/styles.css';

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
