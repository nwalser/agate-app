// Human date helpers for item timestamps (created / updated). Pure formatting
// over the backend's RFC 3339 strings. `relativeFromNow` reads the wall clock, so
// tests pass an explicit `now` (epoch ms) for determinism. An unparseable input
// yields '' rather than "NaN…", so a malformed date degrades quietly.

import { t } from './i18n.ts';

/** "just now" / "5m ago" / "3d ago" / "2mo ago" / "1y ago" for an RFC 3339 date. */
export function relativeFromNow(iso: string, now: number = Date.now()): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return '';
  const sec = Math.max(0, Math.floor((now - parsed) / 1000));
  if (sec < 60) return t('date.justNow');
  const min = Math.floor(sec / 60);
  if (min < 60) return t('date.minutesAgo', { n: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t('date.hoursAgo', { n: hr });
  const day = Math.floor(hr / 24);
  if (day < 30) return t('date.daysAgo', { n: day });
  const mon = Math.floor(day / 30);
  if (mon < 12) return t('date.monthsAgo', { n: mon });
  return t('date.yearsAgo', { n: Math.floor(mon / 12) });
}

/**
 * Future counterpart of `relativeFromNow`: "in moments" / "in 5m" / "in 3d" /
 * "in 2mo" / "in 1y". A date that has already passed falls back to the past
 * phrasing ("5m ago"), so callers can hand it any timestamp.
 */
export function relativeUntil(iso: string, now: number = Date.now()): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return '';
  if (parsed <= now) return relativeFromNow(iso, now);
  const sec = Math.floor((parsed - now) / 1000);
  if (sec < 60) return t('date.inMoments');
  const min = Math.floor(sec / 60);
  if (min < 60) return t('date.inMinutes', { n: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t('date.inHours', { n: hr });
  const day = Math.floor(hr / 24);
  if (day < 30) return t('date.inDays', { n: day });
  const mon = Math.floor(day / 30);
  if (mon < 12) return t('date.inMonths', { n: mon });
  return t('date.inYears', { n: Math.floor(mon / 12) });
}

/** Locale-formatted absolute date/time (for tooltips), or '' if unparseable. */
export function absoluteDate(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return '';
  return new Date(parsed).toLocaleString();
}
