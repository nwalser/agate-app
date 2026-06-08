/**
 * Settings — account summary, the password generator, enabling local-password
 * unlock, the update check, and returning to the vault.
 */
import { expect } from 'chai';
import { $, $$ } from '@wdio/globals';
import {
  FIXTURE_EMAIL,
  clickButtonByText,
  domClickByTitle,
  gotoSettings,
  unlockedFake,
  waitForToast,
} from '../helpers/app.ts';
import { TIMEOUT, waitFor } from '../helpers/wait.ts';

describe('settings', () => {
  it('shows the signed-in account and returns to the vault', async () => {
    await gotoSettings();
    expect(await $('.settings-body').getText()).to.contain(FIXTURE_EMAIL);

    await domClickByTitle('Back');
    await $('.vault').waitForExist({ timeout: TIMEOUT.normal });
    expect(await $('.vault').isExisting()).to.equal(true);
  });

  it('generates a password', async () => {
    await gotoSettings();
    await clickButtonByText('Generate');
    await $('.gen-result').waitForDisplayed({ timeout: TIMEOUT.normal });
    expect(await $('.gen-result code').getText()).to.equal('Xq7!vPz2@Lm9');
  });

  it('enables local-password unlock', async () => {
    await gotoSettings(
      unlockedFake({
        status: {
          loggedIn: true, unlocked: true, localUnlockConfigured: false, helloConfigured: false,
          darkwebConsent: false, email: FIXTURE_EMAIL,
        },
      }),
    );
    const pw = await $$('.settings input[type="password"]');
    await pw[0].setValue('local-pw');
    await pw[1].setValue('local-pw');
    await clickButtonByText('Enable local unlock');

    await waitForToast('Local unlock enabled');
    await $('.settings-enabled').waitForExist({ timeout: TIMEOUT.normal });
  });

  it('reports an available update after checking', async () => {
    await gotoSettings(unlockedFake({ updateVersion: '0.2.0' }));
    await clickButtonByText('Check for updates');
    await waitFor(
      async () => (await $('.settings-update-available').isExisting()),
      'update-available banner never showed',
      TIMEOUT.slow,
    );
    expect(await $('.settings-update-available').getText()).to.contain('0.2.0');
  });
});
