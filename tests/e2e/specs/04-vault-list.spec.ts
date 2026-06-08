/**
 * Vault list — rows render from the synced items, the titlebar search filters
 * them, and the left-rail filters scope by favorites / type / trash.
 */
import { expect } from 'chai';
import { $ } from '@wdio/globals';
import { clickButtonByText, gotoVault, rowNames, setSearch } from '../helpers/app.ts';
import { TIMEOUT, waitFor } from '../helpers/wait.ts';

describe('vault list / search / filters', () => {
  it('renders the non-trashed items', async () => {
    await gotoVault();
    const names = await rowNames();
    expect(names).to.include('GitHub');
    expect(names).to.include('Fastmail');
    expect(names).to.include('Visa ending 4242');
    expect(names).to.not.include('Old MySpace'); // trashed, hidden under All
  });

  it('filters the list via the titlebar search', async () => {
    await gotoVault();
    await setSearch('fast');
    await waitFor(async () => (await rowNames()).length === 1, 'search did not narrow to one row');
    expect(await rowNames()).to.deep.equal(['Fastmail']);
  });

  it('shows an empty-state when nothing matches', async () => {
    await gotoVault();
    await setSearch('zzzzz-no-match');
    await $('.vault-empty').waitForDisplayed({ timeout: TIMEOUT.normal });
  });

  it('scopes to favorites via the rail', async () => {
    await gotoVault();
    await clickButtonByText('Favorites');
    await waitFor(async () => (await rowNames()).length === 1, 'favorites filter did not apply');
    expect(await rowNames()).to.deep.equal(['GitHub']);
  });

  it('scopes to a single item type via the rail', async () => {
    await gotoVault();
    await clickButtonByText('Cards');
    await waitFor(async () => (await rowNames()).length === 1, 'card filter did not apply');
    expect(await rowNames()).to.deep.equal(['Visa ending 4242']);
  });

  it('shows only trashed items under Trash', async () => {
    await gotoVault();
    await clickButtonByText('Trash');
    await waitFor(async () => (await rowNames()).includes('Old MySpace'), 'trash filter did not reveal trashed item');
    expect(await rowNames()).to.deep.equal(['Old MySpace']);
  });
});
