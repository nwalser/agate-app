// The shared unlock success-beat timing. The main Unlock screen and the tray
// popup both play their success animation on the same session change (the
// backend broadcasts it to every webview), so they must hold the beat for the
// SAME duration to feel like one event. The CSS animations that visualize the
// beat (Unlock.css, TrayApp.css) are tuned to these numbers — change together.

export const UNLOCK_BEAT_MS = 720;
export const UNLOCK_BEAT_REDUCED_MS = 120;
