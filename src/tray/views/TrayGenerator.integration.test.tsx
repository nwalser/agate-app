// Integration tests for the tray generator view: the REAL TrayGenerator over the
// REAL lib/ipc + lib/clipboard paths, with the Tauri bridge mocked at its lowest
// boundary (mockIPC), mirroring TrayApp.integration.test.tsx. Asserts the
// GeneratorPage-parity behavior the view ports: auto-generate on open and on
// option change, the per-mode option payloads, the username readiness gate, and
// that Copy goes through the one clipboard path.

import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import TrayGenerator from './TrayGenerator.tsx';
import { dismissToast, toasts } from '../../state/toast.ts';

// ── Fake backend ─────────────────────────────────────────────────────────────
// Deterministic, counting generators + a clipboard. Unknown commands throw
// loudly so a new IPC call in the view can't silently no-op through these tests.

function makeBackend() {
  const state = { clipboard: '' };
  const counters = { password: 0, passphrase: 0, username: 0 };
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];

  function handle(cmd: string, args: Record<string, unknown>): unknown {
    switch (cmd) {
      case 'generate_password':
        counters.password += 1;
        return `pw-${counters.password}`;
      case 'generate_passphrase':
        counters.passphrase += 1;
        return `Word-${counters.passphrase}-word`;
      case 'generate_username':
        counters.username += 1;
        return `user+${counters.username}@x.com`;
      case 'plugin:clipboard-manager|write_text':
        state.clipboard = String(args.text);
        return null;
      case 'plugin:clipboard-manager|read_text':
        return state.clipboard;
      default:
        throw new Error(`unmocked IPC command: ${cmd}`);
    }
  }

  return {
    state,
    calls,
    install() {
      mockIPC((cmd, payload) => {
        const args = (payload ?? {}) as Record<string, unknown>;
        calls.push({ cmd, args });
        return handle(cmd, args);
      });
    },
    invoked(cmd: string) {
      return calls.filter((c) => c.cmd === cmd);
    },
  };
}

function renderGen(backend: ReturnType<typeof makeBackend>, onBack = vi.fn()) {
  backend.install();
  render(() => <TrayGenerator onBack={onBack} />);
  return onBack;
}

beforeEach(() => {
  localStorage.clear();
  // The toast pipeline is a module-level singleton — drop leftovers so a toast
  // from one test can't satisfy an assertion in the next.
  for (const t of toasts()) dismissToast(t.id);
});

afterEach(() => {
  cleanup();
  clearMocks();
});

describe('TrayGenerator integration', () => {
  it('auto-generates a password on open with the GeneratorPage defaults', async () => {
    const backend = makeBackend();
    renderGen(backend);

    await screen.findByText('pw-1');
    expect(backend.invoked('generate_password')).toHaveLength(1);
    expect(backend.invoked('generate_password')[0]?.args.options).toMatchObject({
      length: 16,
      uppercase: true,
      lowercase: true,
      numbers: true,
      special: true,
      avoidAmbiguous: false,
    });
  });

  it('regenerate produces a fresh value', async () => {
    const backend = makeBackend();
    renderGen(backend);
    await screen.findByText('pw-1');

    fireEvent.click(screen.getByTitle('Regenerate'));

    await screen.findByText('pw-2');
  });

  it('an option change auto-regenerates with the new payload', async () => {
    const backend = makeBackend();
    renderGen(backend);
    await screen.findByText('pw-1');

    fireEvent.click(screen.getByLabelText('A-Z'));

    await waitFor(() => expect(backend.invoked('generate_password')).toHaveLength(2));
    expect(backend.invoked('generate_password')[1]?.args.options).toMatchObject({
      uppercase: false,
      lowercase: true,
    });
  });

  it('with every charset off it shows the note and never calls the backend', async () => {
    const backend = makeBackend();
    renderGen(backend);
    await screen.findByText('pw-1');

    fireEvent.click(screen.getByLabelText('A-Z'));
    fireEvent.click(screen.getByLabelText('a-z'));
    fireEvent.click(screen.getByLabelText('0-9'));
    fireEvent.click(screen.getByLabelText('!@#'));

    await screen.findByText('Pick at least one character set.');
    // 1 initial + one per toggle that still had a charset left; the final
    // all-off state must not reach the backend.
    expect(backend.invoked('generate_password')).toHaveLength(4);
  });

  it('passphrase mode generates with the GeneratorPage defaults', async () => {
    const backend = makeBackend();
    renderGen(backend);
    await screen.findByText('pw-1');

    fireEvent.click(screen.getByRole('tab', { name: 'Passphrase' }));

    await screen.findByText('Word-1-word');
    expect(backend.invoked('generate_passphrase')[0]?.args.options).toMatchObject({
      numWords: 4,
      wordSeparator: '-',
      capitalize: true,
      includeNumber: true,
    });
  });

  it('username mode gates on a usable base email, then generates', async () => {
    const backend = makeBackend();
    renderGen(backend);
    await screen.findByText('pw-1');

    fireEvent.click(screen.getByRole('tab', { name: 'Username' }));

    // Incomplete input → the readiness gate keeps the backend out of it.
    await screen.findByText('Enter a base email or domain.');
    expect(backend.invoked('generate_username')).toHaveLength(0);

    fireEvent.input(screen.getByPlaceholderText('you@example.com'), {
      target: { value: 'me@x.com' },
    });

    await screen.findByText('user+1@x.com');
    expect(backend.invoked('generate_username')[0]?.args.options).toMatchObject({
      mode: 'plusAddressed',
      email: 'me@x.com',
    });
  });

  it('Copy writes the value through the one clipboard path', async () => {
    const backend = makeBackend();
    renderGen(backend);
    await screen.findByText('pw-1');

    fireEvent.click(screen.getByLabelText('Copy'));

    await waitFor(() => expect(backend.state.clipboard).toBe('pw-1'));
  });

  it('the back button calls onBack', async () => {
    const backend = makeBackend();
    const onBack = renderGen(backend);
    await screen.findByText('pw-1');

    fireEvent.click(screen.getByTitle('Back'));

    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
