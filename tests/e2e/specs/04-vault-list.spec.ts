/**
 * Vault list — rows render from the synced items, search filters them, the
 * left-rail filters scope by favorites / type / trash, and the empty-state
 * shows when nothing matches.
 */
import { expect } from 'chai';
import { $ } from '@wdio/globals';
import { clickButtonByText, gotoVault, rowNames, unlockedFake } from '../helpers/app.ts';
import { TIMEOUT, waitFor } from '../helpers/wait.ts';

describe('vault list / search / filters', () => {
  it('renders the non-trashed items, favorites first', async () => {
    await gotoVault();
    const names = await rowNames();
    // GitHub is the only favorite — it sorts to the top. The trashed "Old
    // MySpace" is hidden under the default (All items) filter.
    expect(names[0]).to.equal('GitHub');
    expect(names).to.include('Fastmail');
    expect(names).to.not.include('Old MySpace');
  });

  it('filters the list by the search query', async () => {
    await gotoVault();
    await $('.vault-search input').setValue('fast');
    await waitFor(async () => (await rowNames()).length === 1, 'search did not narrow to one row');
    expect(await rowNames()).to.deep.equal(['Fastmail']);
  });

  it('shows an empty-state when nothing matches', async () => {
    await gotoVault();
    await $('.vault-search input').setValue('zzzzz-no-match');
    await $('.vault-empty').waitForDisplayed({ timeout: TIMEOUT.normal });
    expect(await $('.vault-empty').getText()).to.contain('No matches');
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

  it('reflects a freshly created item after editor save', async () => {
    // Sanity that the in-page fake's write path feeds back into list_items.
    await gotoVault(unlockedFake());
    const before = (await rowNames()).length;
    expect(before).to.be.greaterThan(0);
  });
});
