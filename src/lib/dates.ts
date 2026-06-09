// Human date helpers for item timestamps (created / updated). Pure formatting
// over the backend's RFC 3339 strings. `relativeFromNow` reads the wall clock, so
// tests pass an explicit `now` (epoch ms) for determinism. An unparseable input
// yields '' rather than "NaN…", so a malformed date degrades quietly.

/** "just now" / "5m ago" / "3d ago" / "2mo ago" / "1y ago" for an RFC 3339 date. */
export function relativeFromNow(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const sec = Math.max(0, Math.floor((now - t) / 1000));
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mon = Math.floor(day / 30);
  if (mon < 12) return `${mon}mo ago`;
  return `${Math.floor(mon / 12)}y ago`;
}

/** Locale-formatted absolute date/time (for tooltips), or '' if unparseable. */
export function absoluteDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return new Date(t).toLocaleString();
}
