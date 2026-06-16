import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { pushToast } from '../state/toast.ts';
import { copyState } from '../state/copyFeedback.ts';
import { copyWithAutoClear } from './clipboard.ts';

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  writeText: vi.fn().mockResolvedValue(undefined),
  readText: vi.fn().mockResolvedValue(''),
}));
vi.mock('../state/clipboard.ts', () => ({ clipboardClearSeconds: () => 15 }));
vi.mock('../state/toast.ts', () => ({ pushToast: vi.fn(), toastError: vi.fn() }));

const writeMock = vi.mocked(writeText);
const readMock = vi.mocked(readText);
const toastMock = vi.mocked(pushToast);

describe('copyWithAutoClear', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('records a secret copy in the feedback store and auto-clears after the delay', async () => {
    vi.useFakeTimers();
    readMock.mockResolvedValue('s3cret');
    await copyWithAutoClear('Password', 's3cret');

    expect(writeMock).toHaveBeenCalledWith('s3cret');
    // Feedback, not a toast: the countdown starts at the configured 15s.
    expect(copyState().clearSeconds).toBe(15);
    expect(copyState().remaining).toBe(15);
    expect(toastMock).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();
    expect(writeMock).toHaveBeenCalledWith(''); // wiped
    expect(copyState().remaining).toBe(0); // countdown ended
  });

  it('does NOT wipe a value the user copied over the secret (no clobber)', async () => {
    vi.useFakeTimers();
    // By the time the timer fires the clipboard holds something the user copied
    // AFTER our secret — wiping it would destroy the user's own copy.
    readMock.mockResolvedValue('user-copied-this-later');
    await copyWithAutoClear('Password', 's3cret');

    expect(writeMock).toHaveBeenCalledWith('s3cret');
    await vi.runAllTimersAsync();
    // The wipe is conditional on the clipboard still holding our secret; it
    // doesn't, so we must never blank what replaced it.
    expect(writeMock).not.toHaveBeenCalledWith('');
    expect(writeMock).toHaveBeenCalledTimes(1);
    // Our countdown still ended (the clipboard is no longer ours to manage).
    expect(copyState().remaining).toBe(0);
  });

  it.each(['Username', 'Website', 'URL', 'Folder', 'Public key', 'Fingerprint', 'Cardholder'])(
    'never auto-clears a copied %s (no countdown, no toast)',
    async (label) => {
      vi.useFakeTimers();
      readMock.mockResolvedValue('val');
      await copyWithAutoClear(label, 'val');

      expect(writeMock).toHaveBeenCalledWith('val');
      // Non-secret: recorded with a 0s window (no countdown), never toasted.
      expect(copyState().clearSeconds).toBe(0);
      expect(copyState().remaining).toBe(0);
      expect(toastMock).not.toHaveBeenCalled();

      await vi.runAllTimersAsync();
      expect(writeMock).not.toHaveBeenCalledWith('');
      expect(writeMock).toHaveBeenCalledTimes(1);
    },
  );

  it('does nothing for an empty value', async () => {
    const before = copyState().token;
    await copyWithAutoClear('Password', '');
    expect(writeMock).not.toHaveBeenCalled();
    expect(toastMock).not.toHaveBeenCalled();
    expect(copyState().token).toBe(before); // no copy recorded
  });
});
