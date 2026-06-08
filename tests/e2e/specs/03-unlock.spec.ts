/**
 * Unlock screen — one app password (or Windows Hello) unlocks every connection;
 * "log out of everything" clears the session.
 */
import { expect } from 'chai';
import { $ } from '@wdio/globals';
import { gotoUnlock, unlockAll, lockedFake, clickButtonByText } from '../helpers/app.ts';
import { TIMEOUT } from '../helpers/wait.ts';

describe('unlock (app-unlock)', () => {
  it('shows the locked screen with the connection count', async () => {
    await gotoUnlock();
    expect(await $('.unlock-title').getText()).to.contain('Unlock');
    expect(await $('.unlock-email').getText()).to.contain('connection');
  });

  it('unlocks all connections with the app password', async () => {
    await gotoUnlock();
    await unlockAll('app-pw');
    await $('.vault').waitForExist({ timeout: TIMEOUT.slow });
    expect(await $('.vault').isExisting()).to.equal(true);
  });

  it('offers Windows Hello when configured and unlocks with it', async () => {
    await gotoUnlock(
      lockedFake({
        status: {
          appUnlockConfigured: true, unlocked: false, helloConfigured: true,
          darkwebConsent: false, connectionCount: 1, liveCount: 0,
        },
      }),
    );
    await $('.unlock-hello').waitForExist({ timeout: TIMEOUT.normal });
    await $('.unlock-hello').click();
    await $('.vault').waitForExist({ timeout: TIMEOUT.slow });
    expect(await $('.vault').isExisting()).to.equal(true);
  });

  it('logs out of everything back to setup', async () => {
    await gotoUnlock();
    await clickButtonByText('Log out of everything');
    // logout clears app-unlock config → first-run setup screen (.onboarding shell).
    await $('.onboarding').waitForExist({ timeout: TIMEOUT.normal });
    expect(await $('.unlock').isExisting()).to.equal(false);
  });

  it('surfaces a wrong app password as a toast and stays locked', async () => {
    await gotoUnlock(
      lockedFake({ errors: { unlock_all: { kind: 'invalidCredentials', message: 'Wrong app password.' } } }),
    );
    await unlockAll('nope');
    await $('.unlock').waitForExist({ timeout: TIMEOUT.normal });
    expect(await $('.vault').isExisting()).to.equal(false);
  });
});
