import { render } from 'solid-js/web';
import App from './App.tsx';
import { toastError } from './state/toast.ts';
import { initSecurity } from './state/security.ts';
import { initTheme } from './state/theme.ts';
import './styles.css';

// Paint the persisted theme before first render so there's no dark→light flash.
initTheme();

// Start the periodic security monitors (dark-web + exposed-password checks). They
// self-gate on their Settings toggles and the unlocked state, so this is a no-op
// until the vault is open with a check enabled.
initSecurity();

// Route uncaught errors + unhandled rejections into the toast pipeline so a
// setup-time failure surfaces instead of dying silently in the webview console.
window.addEventListener('error', (e) => toastError(e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => toastError(e.reason));

// The app renders its own UI; suppress the native right-click menu everywhere.
window.addEventListener('contextmenu', (e) => e.preventDefault());

render(() => <App />, document.getElementById('app')!);
