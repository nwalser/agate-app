import { render } from 'solid-js/web';
import TrayApp from './tray/TrayApp.tsx';
import { toastError } from './state/toast.ts';
import { initTheme } from './state/theme.ts';
import { maybeInitLanguageFromSystem } from './lib/i18n.ts';
import { runStartupUpdateCheck } from './state/update.ts';
import './styles.css';

// Single-window app: the tray quick-access popup IS Agate. The window (label
// "tray") starts hidden and is summoned from the tray icon.

// Paint the persisted theme before first render so there's no dark→light flash.
initTheme();

// First-run system-locale detection. Best-effort and async — render immediately;
// a language flip after detection re-renders every t()/tm() consumer reactively.
void maybeInitLanguageFromSystem();

// Independent of auth: silently check (and optionally install) a newer release
// if the user has auto-updates on. Swallows its own errors.
void runStartupUpdateCheck();

// Route uncaught errors + unhandled rejections into the toast pipeline so a
// setup-time failure surfaces instead of dying silently in the webview console.
window.addEventListener('error', (e) => toastError(e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => toastError(e.reason));

// The app renders its own UI; suppress the native right-click menu everywhere.
window.addEventListener('contextmenu', (e) => e.preventDefault());

render(() => <TrayApp />, document.getElementById('app')!);
