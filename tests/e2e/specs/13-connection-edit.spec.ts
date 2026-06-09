/**
 * Connection editing — per-connection store-login (auto-unlock) vs. manual, shown
 * as a badge and toggled from the inline edit form. Uses the in-page fake backend.
 */
import { expect } from 'chai';
import { $ } from '@wdio/globals';
import { clickButtonByText, domClickByTitle, gotoSettings, waitForToast } from '../helpers/app.ts';
import { TIMEOUT } from '../helpers/wait.ts';

describe('connection editing', () => {
  it('shows the store/manual + locked badges', async () => {
    await gotoSettings();
    await $('.settings-account').waitForExist({ timeout: TIMEOUT.normal });
    const badges = await $('.settings-account-badges').getText();
    expect(badges).to.contain('Auto-unlock');
    expect(badges).to.contain('Unlocked');
  });

  it('opens the inline edit form for a connection', async () => {
    await gotoSettings();
    await $('.settings-account').waitForExist({ timeout: TIMEOUT.normal });
    await domClickByTitle('Edit connection');
    await $('.settings-conn-form').waitForExist({ timeout: TIMEOUT.normal });
    // The store-login checkbox starts checked (the fixture is auto-unlock).
    expect(await $('.settings-conn-form input[type="checkbox"]').isSelected()).to.equal(true);
  });

  it('switches a connection to manual unlock', async () => {
    await gotoSettings();
    await $('.settings-account').waitForExist({ timeout: TIMEOUT.normal });
    await domClickByTitle('Edit connection');
    await $('.settings-conn-form').waitForExist({ timeout: TIMEOUT.normal });
    // Uncheck "store login" — a true→false toggle needs no password.
    await $('.settings-conn-form input[type="checkbox"]').click();
    await clickButtonByText('Save changes');
    await waitForToast('Connection updated');
  });
});
