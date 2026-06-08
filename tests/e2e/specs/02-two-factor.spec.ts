/**
 * Two-factor login — when the backend reports `twoFactorRequired`, onboarding
 * shows the 2FA step; submitting a code completes the login into the vault.
 */
import { expect } from 'chai';
import { $ } from '@wdio/globals';
import {
  FIXTURE_EMAIL,
  fillLogin,
  gotoOnboarding,
  loggedOutFake,
  submitLogin,
  waitForToast,
} from '../helpers/app.ts';
import { TIMEOUT } from '../helpers/wait.ts';

function twoFactorFake() {
  return loggedOutFake({
    loginResult: { status: 'twoFactorRequired', providers: ['authenticator', 'email'] },
  });
}

describe('two-factor login', () => {
  it('prompts for a 2FA code when the backend requires it', async () => {
    await gotoOnboarding(twoFactorFake());
    await fillLogin(FIXTURE_EMAIL, 'master-pw');
    await submitLogin();

    await $('input[autocomplete="one-time-code"]').waitForExist({ timeout: TIMEOUT.normal });
    await waitForToast('Two-factor authentication required');
  });

  it('completes login after entering the code', async () => {
    await gotoOnboarding(twoFactorFake());
    await fillLogin(FIXTURE_EMAIL, 'master-pw');
    await submitLogin();

    const code = await $('input[autocomplete="one-time-code"]');
    await code.waitForExist({ timeout: TIMEOUT.normal });
    await code.setValue('123456');
    await $('.onboarding .primary.full').click();

    await $('.vault').waitForExist({ timeout: TIMEOUT.slow });
    expect(await $('.vault').isExisting()).to.equal(true);
  });

  it('can go back from the 2FA step to the credentials form', async () => {
    await gotoOnboarding(twoFactorFake());
    await fillLogin(FIXTURE_EMAIL, 'master-pw');
    await submitLogin();
    await $('input[autocomplete="one-time-code"]').waitForExist({ timeout: TIMEOUT.normal });

    await $('.onboarding .ghost.full').click(); // "Back"
    await $('.onboarding input[type="password"]').waitForExist({ timeout: TIMEOUT.normal });
    expect(await $('input[autocomplete="one-time-code"]').isExisting()).to.equal(false);
  });
});
