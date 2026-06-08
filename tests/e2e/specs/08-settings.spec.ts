/**
 * Settings — connections list, password generator, changing the app-unlock
 * password, and returning to the vault.
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

  it('generates a password', async () => {
    await gotoSettings();
    await clickButtonByText('Generate');
    await $('.gen-result').waitForDisplayed({ timeout: TIMEOUT.normal });
    expect(await $('.gen-result code').getText()).to.equal('Xq7!vPz2@Lm9');
  });

  it('changes the app-unlock password', async () => {
    await gotoSettings();
    const pw = await $$('.settings input[type="password"]');
    await pw[0].setValue('newapppassword');
    await pw[1].setValue('newapppassword');
    await clickButtonByText('Change app password');
    await waitForToast('App password changed');
  });

  it('rejects a too-short new app password', async () => {
    await gotoSettings();
    const pw = await $$('.settings input[type="password"]');
    await pw[0].setValue('short');
    await pw[1].setValue('short');
    await clickButtonByText('Change app password');
    await waitForToast('at least 8 characters');
  });
});
