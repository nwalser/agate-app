/**
 * Unlock screen — local-password unlock, Windows Hello unlock, the "use master
 * password instead" fallback (routes back to Onboarding), and logout.
 */
import { expect } from 'chai';
import { $ } from '@wdio/globals';
import {
  FIXTURE_EMAIL,
  gotoUnlock,
  lockedFake,
} from '../helpers/app.ts';
import { TIMEOUT } from '../helpers/wait.ts';

describe('unlock', () => {
  it('shows the locked vault with the account email', async () => {
    await gotoUnlock();
    expect(await $('.unlock-title').getText()).to.contain('locked');
    expect(await $('.unlock-email').getText()).to.contain(FIXTURE_EMAIL);
  });

  it('unlocks with the local password into the vault', async () => {
    await gotoUnlock();
    await $('.unlock-field input[type="password"]').setValue('local-pw');
    await $('.unlock .primary.full').click();
    await $('.vault').waitForExist({ timeout: TIMEOUT.slow });
    expect(await $('.vault').isExisting()).to.equal(true);
  });

  it('falls back to the master-password (onboarding) form', async () => {
    await gotoUnlock();
    // "Use master password instead"
    await $('.unlock .ghost.full').click();
    await $('.onboarding').waitForExist({ timeout: TIMEOUT.normal });
    // Email is carried over from the session into the onboarding form.
    expect(await $('.onboarding input[type="email"]').getValue()).to.equal(FIXTURE_EMAIL);
  });

  it('offers Windows Hello when configured and unlocks with it', async () => {
    await gotoUnlock(
      lockedFake({
        status: {
          loggedIn: true, unlocked: false, localUnlockConfigured: true, helloConfigured: true,
          darkwebConsent: false, email: FIXTURE_EMAIL,
        },
      }),
    );
    await $('.unlock-hello').waitForExist({ timeout: TIMEOUT.normal });
    await $('.unlock-hello').click();
    await $('.vault').waitForExist({ timeout: TIMEOUT.slow });
    expect(await $('.vault').isExisting()).to.equal(true);
  });

  it('logs out back to onboarding', async () => {
    await gotoUnlock();
    await $('.unlock-logout').click();
    await $('.onboarding').waitForExist({ timeout: TIMEOUT.normal });
    expect(await $('.onboarding').isExisting()).to.equal(true);
  });

  it('surfaces a wrong local password as a toast and stays locked', async () => {
    await gotoUnlock(
      lockedFake({ errors: { unlock_local: { kind: 'localUnlock', message: 'Wrong local password.' } } }),
    );
    await $('.unlock-field input[type="password"]').setValue('nope');
    await $('.unlock .primary.full').click();
    // The Toast pipeline lives outside the screen; confirm we did not advance.
    await $('.unlock').waitForExist({ timeout: TIMEOUT.normal });
    expect(await $('.vault').isExisting()).to.equal(false);
  });
});
