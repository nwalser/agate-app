/**
 * Bulk operations — multi-select via row checkboxes drives the bulk action bar:
 * favorite, move to trash, and (in Trash) restore / delete permanently.
 */
import { expect } from 'chai';
import { $, browser } from '@wdio/globals';
import { clickButtonByText, gotoVault, rowNames, waitForToast } from '../helpers/app.ts';
import { TIMEOUT, waitFor } from '../helpers/wait.ts';

/** Toggle the checkbox of the vault row whose name matches. */
async function checkRow(name: string): Promise<void> {
  const ok = await browser.execute((n: string) => {
    for (const row of Array.from(document.querySelectorAll('.vault-row'))) {
      if ((row.querySelector('.vault-row-name')?.textContent ?? '') === n) {
        const cb = row.querySelector<HTMLInputElement>('.vault-row-check input[type="checkbox"]');
        if (cb) { cb.click(); return true; }
      }
    }
    return false;
  }, name);
  if (!ok) throw new Error(`no vault row named "${name}"`);
}

describe('bulk operations', () => {
  it('shows the bulk bar with a live count as rows are selected', async () => {
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

  it('moves selected items to trash, removing them from the default view', async () => {
    await gotoVault();
    await checkRow('Fastmail');
    await $('.vault-bulk').waitForDisplayed({ timeout: TIMEOUT.normal });
    await $('.vault-bulk-btn[title="Move to trash"]').click();
    await waitForToast('Trashed 1');
    await waitFor(async () => !(await rowNames()).includes('Fastmail'), 'trashed item still shown under All items');
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
