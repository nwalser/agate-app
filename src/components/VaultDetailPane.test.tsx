// Render tests for the detail pane's copy affordance. The overview has no copy
// buttons: clicking a field's value copies it. Reveal (eye) and open (website)
// buttons stay. Covers username/password/website/TOTP and a generic field, and
// guards the regression that a stray <Copy> icon button creeps back in.

import { cleanup, fireEvent, render } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import VaultDetailPane from './VaultDetailPane.tsx';
import { makeDetail, makeLoginDetail } from '../testing/factories.ts';
import type { ItemDetail, LoginDetail, TotpCode } from '../lib/types.ts';

// Pane-local defaults (username/password/uri populated) layered on the shared
// LoginDetail factory so new DTO fields land in one place (factories.ts).
const loginDetail = (over: Partial<LoginDetail> = {}): LoginDetail =>
  makeLoginDetail({
    username: 'alice@example.com',
    password: 'hunter2',
    uris: [{ uri: 'https://example.com', matchType: null }],
    ...over,
  });

const detail = (over: Partial<ItemDetail> = {}): ItemDetail =>
  makeDetail({
    id: 'i1',
    name: 'Example',
    accountEmail: 'a@b.c',
    accountLabel: 'Cloud',
    login: loginDetail(),
    revisionDate: '2024-01-01T00:00:00Z',
    creationDate: '2024-01-01T00:00:00Z',
    ...over,
  });

function renderPane(over: Partial<ItemDetail> = {}, opts: { totp?: TotpCode | null; revealed?: boolean } = {}) {
  const copy = vi.fn();
  const result = render(() => (
    <VaultDetailPane
      detail={detail(over)}
      inTrash={false}
      revealed={opts.revealed ?? false}
      setRevealed={() => undefined}
      totp={opts.totp ?? null}
      selectedSecurity={null}
      selectedBreaches={[]}
      copy={copy}
      onFavorite={() => undefined}
      onEdit={() => undefined}
      onClone={() => undefined}
      onDelete={() => undefined}
      onRestore={() => undefined}
    />
  ));
  return { copy, ...result };
}

describe('VaultDetailPane — copy affordance', () => {
  afterEach(cleanup);

  it('renders no copy buttons in the overview', () => {
    renderPane({}, { totp: { code: '123456', remaining: 20, period: 30 } });
    const copyButtons = Array.from(document.querySelectorAll('button')).filter((b) =>
      (b.getAttribute('title') ?? '').toLowerCase().startsWith('copy'),
    );
    expect(copyButtons).toEqual([]);
  });

  it('renders no copy buttons for non-login items either (card + custom fields)', () => {
    renderPane({
      itemType: 'card',
      login: null,
      card: {
        cardholderName: 'Alice Example',
        number: '4111111111111111',
        brand: 'Visa',
        expMonth: '12',
        expYear: '2030',
        code: '123',
      },
      fields: [{ name: 'PIN', value: '9876', fieldType: 'hidden', linkedId: null }],
    });
    const copyButtons = Array.from(document.querySelectorAll('button')).filter((b) =>
      (b.getAttribute('title') ?? '').toLowerCase().startsWith('copy'),
    );
    expect(copyButtons).toEqual([]);
  });

  it('keeps the reveal and open buttons', () => {
    renderPane();
    expect(document.querySelector('button[title="Reveal"]')).toBeTruthy();
    expect(document.querySelector('button[title="Open"]')).toBeTruthy();
  });

  it('copies the username when its value is clicked', () => {
    const { copy } = renderPane();
    const value = Array.from(document.querySelectorAll('.detail-value')).find(
      (el) => el.textContent === 'alice@example.com',
    )!;
    fireEvent.click(value);
    expect(copy).toHaveBeenCalledWith('Username', 'alice@example.com');
  });

  it('copies the password when its (masked) value is clicked', () => {
    const { copy } = renderPane();
    const value = document.querySelector('.detail-value.mono')!;
    fireEvent.click(value);
    expect(copy).toHaveBeenCalledWith('Password', 'hunter2');
  });

  it('copies the website when its value is clicked', () => {
    const { copy } = renderPane();
    const value = Array.from(document.querySelectorAll('.detail-value')).find(
      (el) => el.textContent === 'https://example.com',
    )!;
    fireEvent.click(value);
    expect(copy).toHaveBeenCalledWith('URL', 'https://example.com');
  });

  it('copies the one-time code when its value is clicked', () => {
    const { copy } = renderPane({}, { totp: { code: '123456', remaining: 20, period: 30 } });
    const value = document.querySelector('.totp-code')!;
    fireEvent.click(value);
    expect(copy).toHaveBeenCalledWith('Code', '123456');
  });

  it('gates the one-time code behind reprompt like the password', () => {
    const { copy } = renderPane(
      { reprompt: true },
      { totp: { code: '123456', remaining: 20, period: 30 } },
    );
    const code = document.querySelector('.totp-code')!;
    // Masked on screen — reprompt protects reading the code, not just copying it.
    expect(code.textContent).not.toContain('123456');
    fireEvent.click(code);
    expect(copy).not.toHaveBeenCalled();
  });
});

describe('VaultDetailPane — surfaced login metadata', () => {
  afterEach(cleanup);

  it('shows when the password was last changed', () => {
    renderPane({ login: loginDetail({ passwordRevisionDate: '2024-03-04T05:06:07Z' }) });
    expect(document.querySelector('.detail-pw-updated')).toBeTruthy();
  });

  it('omits the password-updated row when no revision date', () => {
    renderPane({ login: loginDetail({ passwordRevisionDate: null }) });
    expect(document.querySelector('.detail-pw-updated')).toBeNull();
  });

  it('shows the autofill-on-page-load chip only when enabled', () => {
    renderPane({ login: loginDetail({ autofillOnPageLoad: true }) });
    expect(document.querySelector('.detail-autofill')).toBeTruthy();

    cleanup();
    renderPane({ login: loginDetail({ autofillOnPageLoad: null }) });
    expect(document.querySelector('.detail-autofill')).toBeNull();
  });

  it('hides password-history entries until the section is expanded', () => {
    renderPane({
      login: loginDetail({
        passwordHistory: [
          { password: 'oldsecret1', lastUsedDate: '2024-01-01T00:00:00Z' },
          { password: 'oldsecret2', lastUsedDate: '2023-01-01T00:00:00Z' },
        ],
      }),
    });
    const toggle = document.querySelector<HTMLButtonElement>('.detail-pwhist-toggle')!;
    expect(toggle).toBeTruthy();
    // Count in the toggle, but the secrets are not in the DOM yet.
    expect(toggle.textContent).toContain('2');
    expect(document.body.textContent).not.toContain('oldsecret1');

    fireEvent.click(toggle);
    expect(document.body.textContent).toContain('oldsecret1');
    expect(document.body.textContent).toContain('oldsecret2');
  });

  it('copies a past password when its revealed value is clicked', () => {
    const { copy } = renderPane({
      login: loginDetail({
        passwordHistory: [{ password: 'oldsecret1', lastUsedDate: '2024-01-01T00:00:00Z' }],
      }),
    });
    fireEvent.click(document.querySelector('.detail-pwhist-toggle')!);
    const value = Array.from(document.querySelectorAll('.detail-pwhist-row .detail-value')).find(
      (el) => el.textContent === 'oldsecret1',
    )!;
    fireEvent.click(value);
    expect(copy).toHaveBeenCalledWith('Password', 'oldsecret1');
  });

  it('keeps password history gated behind reprompt', () => {
    renderPane({
      reprompt: true,
      login: loginDetail({
        passwordHistory: [{ password: 'oldsecret1', lastUsedDate: '2024-01-01T00:00:00Z' }],
      }),
    });
    fireEvent.click(document.querySelector('.detail-pwhist-toggle')!);
    // Reprompt blocks the expand action, so the secret never enters the DOM.
    expect(document.body.textContent).not.toContain('oldsecret1');
  });
});
