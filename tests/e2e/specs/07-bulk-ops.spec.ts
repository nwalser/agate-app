/**
 * Bulk operations — multi-select via row checkboxes drives the bulk action bar:
 * favorite, move to trash, and (in Trash) restore.
 */
import { expect } from 'chai';
import { $ } from '@wdio/globals';
import { checkRow, clickButtonByText, gotoVault, rowNames, waitForToast } from '../helpers/app.ts';
import { TIMEOUT, waitFor } from '../helpers/wait.ts';

describe('bulk operations', () => {
  it('shows the bulk bar with a live count', async () => {
    await gotoVault();
    await checkRow('GitHub');
    await checkRow('Fastmail');
    await $('.vault-bulk').waitForDisplayed({ timeout: TIMEOUT.normal });
    expect(await $('.vault-bulk-count').getText()).to.contain('2 selected');
  });

  it('favorites the selected items', async () => {
    await gotoVault();
    await checkRow('Fastmail');
    await $('.vault-bulk').waitForDisplayed({ timeout: TIMEOUT.normal });
    await $('.vault-bulk-btn[title="Favorite"]').click();
    await waitForToast('Updated 1 item');
  });

  it('moves selected items to trash', async () => {
    await gotoVault();
    await checkRow('Fastmail');
    await $('.vault-bulk').waitForDisplayed({ timeout: TIMEOUT.normal });
    await $('.vault-bulk-btn[title="Move to trash"]').click();
    await waitForToast('Trashed 1');
    await waitFor(async () => !(await rowNames()).includes('Fastmail'), 'trashed item still shown under All');
  });

  it('restores a trashed item from the Trash view', async () => {
    await gotoVault();
    await clickButtonByText('Trash');
    await waitFor(async () => (await rowNames()).includes('Old MySpace'), 'trash view empty');
    await checkRow('Old MySpace');
    await $('.vault-bulk').waitForDisplayed({ timeout: TIMEOUT.normal });
    await $('.vault-bulk-btn[title="Restore"]').click();
    await waitForToast('Restored 1');
  });
});
