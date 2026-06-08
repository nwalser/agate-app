import { render } from 'solid-js/web';
import App from './App.tsx';
import { toastError } from './state/toast.ts';
import './styles.css';

// Route uncaught errors + unhandled rejections into the toast pipeline so a
// setup-time failure surfaces instead of dying silently in the webview console.
window.addEventListener('error', (e) => toastError(e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => toastError(e.reason));

// The app renders its own UI; suppress the native right-click menu everywhere.
window.addEventListener('contextmenu', (e) => e.preventDefault());

render(() => <App />, document.getElementById('app')!);
