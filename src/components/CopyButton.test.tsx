import { cleanup, fireEvent, render } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CopyButton from './CopyButton.tsx';
import { copyState, noteCopied, endCopy } from '../state/copyFeedback.ts';

// Let the awaited onCopy + the synchronous state reads after it settle.
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('CopyButton', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    endCopy(copyState().token); // clear any leftover countdown
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('runs the copy on click', async () => {
    const onCopy = vi.fn(() => void noteCopied(0));
    render(() => <CopyButton onCopy={onCopy} />);
    fireEvent.click(document.querySelector('.copy-btn')!);
    await flush();
    expect(onCopy).toHaveBeenCalledTimes(1);
  });

  it('flashes a check, then morphs into a countdown that ticks down and reverts', async () => {
    render(() => <CopyButton onCopy={() => void noteCopied(15)} />);
    const btn = document.querySelector('.copy-btn')!;

    fireEvent.click(btn);
    await flush();
    // Immediately after copy: the check beat (no countdown yet).
    expect(btn.classList.contains('is-copied')).toBe(true);
    expect(btn.querySelector('.copy-btn-count')).toBeNull();

    // Check beat ends → the countdown appears at the full window.
    await vi.advanceTimersByTimeAsync(650);
    expect(btn.classList.contains('is-copied')).toBe(false);
    expect(btn.classList.contains('is-counting')).toBe(true);
    expect(btn.querySelector('.copy-btn-count')!.textContent).toBe('15');

    // It counts down with the clipboard clock.
    await vi.advanceTimersByTimeAsync(1000);
    expect(btn.querySelector('.copy-btn-count')!.textContent).toBe('14');

    // At zero the wipe lands and the button reverts to the plain copy icon.
    await vi.advanceTimersByTimeAsync(14_000);
    expect(btn.classList.contains('is-counting')).toBe(false);
    expect(btn.querySelector('.copy-btn-count')).toBeNull();
  });

  it('a non-secret copy flashes the check but shows no countdown', async () => {
    render(() => <CopyButton onCopy={() => void noteCopied(0)} />);
    const btn = document.querySelector('.copy-btn')!;

    fireEvent.click(btn);
    await flush();
    expect(btn.classList.contains('is-copied')).toBe(true);

    await vi.advanceTimersByTimeAsync(650);
    expect(btn.classList.contains('is-counting')).toBe(false);
    expect(btn.querySelector('.copy-btn-count')).toBeNull();
  });

  it('does not flash when nothing was copied (empty value → no token bump)', async () => {
    // onCopy that performs no copy (e.g. copyWithAutoClear on an empty value).
    render(() => <CopyButton onCopy={() => undefined} />);
    const btn = document.querySelector('.copy-btn')!;

    fireEvent.click(btn);
    await flush();
    expect(btn.classList.contains('is-copied')).toBe(false);
    expect(btn.querySelector('.copy-btn-count')).toBeNull();
  });

  it('reverts when a newer copy elsewhere takes over the clipboard', async () => {
    render(() => <CopyButton onCopy={() => void noteCopied(15)} />);
    const btn = document.querySelector('.copy-btn')!;

    fireEvent.click(btn);
    await flush();
    await vi.advanceTimersByTimeAsync(650);
    expect(btn.querySelector('.copy-btn-count')!.textContent).toBe('15');

    // Something else gets copied — a new token wins; this button steps aside.
    noteCopied(30);
    await flush();
    expect(btn.classList.contains('is-counting')).toBe(false);
    expect(btn.querySelector('.copy-btn-count')).toBeNull();
  });
});
