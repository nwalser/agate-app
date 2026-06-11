import { render } from 'solid-js/web';
import { getCurrentWindow } from '@tauri-apps/api/window';
import App from './App.tsx';
import TrayApp from './tray/TrayApp.tsx';
import { toastError } from './state/toast.ts';
import { initSecurity } from './state/security.ts';
import { initTheme } from './state/theme.ts';
import { maybeInitLanguageFromSystem } from './lib/i18n.ts';
import './styles.css';

// This bundle boots both webviews: the main window renders <App/>, the tray
// quick-access popup (second window in tauri.conf.json) renders <TrayApp/>.
const isTrayPopup = getCurrentWindow().label === 'tray';

// Paint the persisted theme before first render so there's no dark→light flash.
initTheme();

// First-run system-locale detection. Best-effort and async — render immediately;
// a language flip after detection re-renders every t()/tm() consumer reactively.
void maybeInitLanguageFromSystem();

// Start the periodic security monitors (dark-web + exposed-password checks). They
// self-gate on their Settings toggles and the unlocked state, so this is a no-op
// until the vault is open with a check enabled. Main window only — the popup
// must not run a second copy of the monitors (or the update check in App).
if (!isTrayPopup) initSecurity();

// Route uncaught errors + unhandled rejections into the toast pipeline so a
// setup-time failure surfaces instead of dying silently in the webview console.
window.addEventListener('error', (e) => toastError(e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => toastError(e.reason));

// The app renders its own UI; suppress the native right-click menu everywhere.
window.addEventListener('contextmenu', (e) => e.preventDefault());

render(() => (isTrayPopup ? <TrayApp /> : <App />), document.getElementById('app')!);
