import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { pushToast } from '../state/toast.ts';
import { copyWithAutoClear } from './clipboard.ts';

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  writeText: vi.fn().mockResolvedValue(undefined),
  readText: vi.fn().mockResolvedValue(''),
}));
vi.mock('../state/clipboard.ts', () => ({ clipboardClearSeconds: () => 15 }));
vi.mock('../state/toast.ts', () => ({ pushToast: vi.fn(), toastError: vi.fn() }));
// Identity `t` so the toast message equals the i18n key — lets us assert which
// branch (plain "copied" vs "copied + clears in Ns") ran.
vi.mock('./i18n.ts', () => ({ t: (key: string) => key }));

const writeMock = vi.mocked(writeText);
const readMock = vi.mocked(readText);
const toastMock = vi.mocked(pushToast);

describe('copyWithAutoClear', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('auto-clears a copied secret after the configured delay', async () => {
    vi.useFakeTimers();
    readMock.mockResolvedValue('s3cret');
    await copyWithAutoClear('Password', 's3cret');

    expect(writeMock).toHaveBeenCalledWith('s3cret');
    expect(toastMock).toHaveBeenCalledWith('success', 'clipboard.copiedClears');

    await vi.runAllTimersAsync();
    expect(writeMock).toHaveBeenCalledWith(''); // wiped
  });

  it.each(['Username', 'Website', 'URL', 'Folder', 'Public key', 'Fingerprint', 'Cardholder'])(
    'never auto-clears a copied %s',
    async (label) => {
      vi.useFakeTimers();
      readMock.mockResolvedValue('val');
      await copyWithAutoClear(label, 'val');

      expect(writeMock).toHaveBeenCalledWith('val');
      // Plain "copied" toast — never the "clears in Ns" variant.
      expect(toastMock).toHaveBeenCalledWith('success', 'clipboard.copied');

      await vi.runAllTimersAsync();
      expect(writeMock).not.toHaveBeenCalledWith('');
      expect(writeMock).toHaveBeenCalledTimes(1);
    },
  );

  it('does nothing for an empty value', async () => {
    await copyWithAutoClear('Password', '');
    expect(writeMock).not.toHaveBeenCalled();
    expect(toastMock).not.toHaveBeenCalled();
  });
});
