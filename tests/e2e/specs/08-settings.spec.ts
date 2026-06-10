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
    // Two group headers split the nav: Vault first, then Global.
    const groups = await $$('.settings-nav-group');
    expect(groups.length).to.equal(2);
    // getText() returns the RENDERED text (CSS uppercases the headers).
    expect((await groups[0].getText()).toUpperCase()).to.equal('VAULT');
    expect((await groups[1].getText()).toUpperCase()).to.equal('GLOBAL');
    await domClickByTitle('Unlock');
    await $('.settings-method-state').waitForExist({ timeout: TIMEOUT.normal });
    // Unlock methods stack one after the other, in order (rendered text is
    // CSS-uppercased, so compare case-insensitively).
    const heads = await $$('.settings .settings-section h3');
    expect(heads.length).to.be.at.least(4);
    expect((await heads[0].getText()).toUpperCase()).to.contain('APP PASSWORD');
    expect((await heads[1].getText()).toUpperCase()).to.contain('THIS DEVICE');
    await domClickByTitle('Appearance');
    await $('.setting-select').waitForExist({ timeout: TIMEOUT.normal });
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
