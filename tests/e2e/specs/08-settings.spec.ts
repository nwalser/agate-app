/**
 * Settings — connections list, changing the app-unlock password / device binding,
 * and returning to the vault. (The password generator now lives on its own page —
 * see 12-generator.spec.ts.)
 */
import { expect } from 'chai';
import { $, $$ } from '@wdio/globals';
import {
  FIXTURE_EMAIL,
  clickButtonByText,
  domClickByTitle,
  gotoSettings,
  waitForToast,
} from '../helpers/app.ts';
import { TIMEOUT } from '../helpers/wait.ts';

describe('settings', () => {
  it('shows the connection + returns to the vault', async () => {
    await gotoSettings();
    expect(await $('.settings-body').getText()).to.contain(FIXTURE_EMAIL);
    await domClickByTitle('Back');
    await $('.vault').waitForExist({ timeout: TIMEOUT.normal });
  });

  it('updates the app-unlock password', async () => {
    await gotoSettings();
    const pw = await $$('.settings input[type="password"]');
    await pw[0].setValue('newapppassword');
    await pw[1].setValue('newapppassword');
    await clickButtonByText('Update app unlock');
    await waitForToast('App unlock updated');
  });

  it('rejects a too-short new app password', async () => {
    await gotoSettings();
    const pw = await $$('.settings input[type="password"]');
    await pw[0].setValue('short');
    await pw[1].setValue('short');
    await clickButtonByText('Update app unlock');
    await waitForToast('at least 8 characters');
  });
});
