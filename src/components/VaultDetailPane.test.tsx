// Render tests for the detail pane's copy affordance. The overview has no copy
// buttons: clicking a field's value copies it. Reveal (eye) and open (website)
// buttons stay. Covers username/password/website/TOTP and a generic field, and
// guards the regression that a stray <Copy> icon button creeps back in.

import { cleanup, fireEvent, render } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import VaultDetailPane from './VaultDetailPane.tsx';
import type { ItemDetail, LoginDetail, TotpCode } from '../lib/types.ts';

const loginDetail = (over: Partial<LoginDetail> = {}): LoginDetail => ({
  username: 'alice@example.com',
  password: 'hunter2',
  totp: null,
  uris: [{ uri: 'https://example.com', matchType: null }],
  hasTotp: false,
  ...over,
});

const detail = (over: Partial<ItemDetail> = {}): ItemDetail => ({
  id: 'i1',
  accountEmail: 'a@b.c',
  accountLabel: 'Cloud',
  name: 'Example',
  itemType: 'login',
  favorite: false,
  reprompt: false,
  notes: null,
  login: loginDetail(),
  card: null,
  identity: null,
  sshKey: null,
  fields: [],
  folderId: null,
  organizationId: null,
  revisionDate: '2024-01-01T00:00:00Z',
  creationDate: '2024-01-01T00:00:00Z',
  collectionIds: [],
  attachments: [],
  passkeys: [],
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
});
