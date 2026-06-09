/**
 * Settings — split into pages reached from a left sub-nav (Connections, Unlock,
 * Security, Appearance, Updates, About). Reached from the sidebar bottom. Covers
 * the default (Connections) page, page navigation, and the app-unlock page.
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
  it('opens on the connections page + returns to the vault', async () => {
    await gotoSettings();
    expect(await $('.settings-content').getText()).to.contain(FIXTURE_EMAIL);
    await domClickByTitle('Back');
    await $('.vault').waitForExist({ timeout: TIMEOUT.normal });
  });

  it('navigates between settings pages via the sub-nav', async () => {
    await gotoSettings();
    await domClickByTitle('Unlock');
    await $('.settings-method').waitForExist({ timeout: TIMEOUT.normal });
    await domClickByTitle('Appearance');
    await $('.theme-options').waitForExist({ timeout: TIMEOUT.normal });
  });

  it('updates the app-unlock password', async () => {
    await gotoSettings();
    await domClickByTitle('Unlock');
    await $('.settings input[type="password"]').waitForExist({ timeout: TIMEOUT.normal });
    const pw = await $$('.settings input[type="password"]');
    await pw[0].setValue('newapppassword');
    await pw[1].setValue('newapppassword');
    await clickButtonByText('Update app unlock');
    await waitForToast('App unlock updated');
  });

  it('rejects a too-short new app password', async () => {
    await gotoSettings();
    await domClickByTitle('Unlock');
    await $('.settings input[type="password"]').waitForExist({ timeout: TIMEOUT.normal });
    const pw = await $$('.settings input[type="password"]');
    await pw[0].setValue('short');
    await pw[1].setValue('short');
    await clickButtonByText('Update app unlock');
    await waitForToast('at least 8 characters');
  });
});
