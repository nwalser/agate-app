/**
 * Item editor — create a new login, edit an existing item, use the password
 * generator. Saves feed back through the fake's write path into the list.
 */
import { expect } from 'chai';
import { $ } from '@wdio/globals';
import {
  clickButtonByText,
  clickRow,
  domClickByTitle,
  gotoVault,
  rowNames,
  waitForToast,
} from '../helpers/app.ts';
import { TIMEOUT, waitFor } from '../helpers/wait.ts';

async function openCreateLogin(): Promise<void> {
  await $('.vault-add').click();
  await $('.vault-menu').waitForDisplayed({ timeout: TIMEOUT.normal });
  await clickButtonByText('Login');
  await $('.item-editor').waitForExist({ timeout: TIMEOUT.normal });
}

describe('item editor', () => {
  it('creates a new login and shows it in the list', async () => {
    await gotoVault();
    await openCreateLogin();
    await $('.item-editor input[placeholder="Name"]').setValue('My Test Login');
    await $('.ie-footer .primary').click();
    await waitForToast('Item saved');
    await waitFor(async () => (await rowNames()).includes('My Test Login'), 'new item did not appear');
  });

  it('generates a password into the editor field', async () => {
    await gotoVault();
    await openCreateLogin();
    await domClickByTitle('Generate');
    await $('.ie-gen-popover').waitForDisplayed({ timeout: TIMEOUT.normal });
    await $('.ie-gen-go').click();
    await waitFor(
      async () => (await $('.ie-pw-row input').getValue()).length > 0,
      'generator did not fill the password field',
    );
    expect(await $('.ie-pw-row input').getValue()).to.equal('Xq7!vPz2@Lm9');
  });

  it('edits an existing item', async () => {
    await gotoVault();
    await clickRow('Fastmail');
    await $('.detail-name').waitForExist({ timeout: TIMEOUT.normal });
    await domClickByTitle('Edit');
    await $('.item-editor').waitForExist({ timeout: TIMEOUT.normal });
    const name = await $('.item-editor input[placeholder="Name"]');
    expect(await name.getValue()).to.equal('Fastmail');
    await name.setValue('Fastmail (renamed)');
    await $('.ie-footer .primary').click();
    await waitForToast('Item saved');
    await waitFor(async () => (await rowNames()).includes('Fastmail (renamed)'), 'rename did not reflect in list');
  });

  it('closes via Cancel without saving', async () => {
    await gotoVault();
    await openCreateLogin();
    await clickButtonByText('Cancel');
    await waitFor(async () => !(await $('.item-editor').isExisting()), 'editor did not close on Cancel');
  });
});
