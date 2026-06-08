/**
 * Two-factor on unlock — when a connection still enforces 2FA, "unlock all" drops
 * into a per-connection code step; submitting the code finishes into the vault.
 */
import { expect } from 'chai';
import { $ } from '@wdio/globals';
import { gotoUnlock, unlockAll, lockedFake, waitForToast } from '../helpers/app.ts';
import { TIMEOUT } from '../helpers/wait.ts';

describe('two-factor on unlock', () => {
  it('prompts for a 2FA code when a connection requires it', async () => {
    await gotoUnlock(lockedFake({ twoFactor: true }));
    await unlockAll('app-pw');
    await $('input[autocomplete="one-time-code"]').waitForExist({ timeout: TIMEOUT.normal });
    expect(await $('.unlock-title').getText()).to.contain('Two-factor');
  });

  it('completes the unlock after entering the code', async () => {
    await gotoUnlock(lockedFake({ twoFactor: true }));
    await unlockAll('app-pw');
    const code = await $('input[autocomplete="one-time-code"]');
    await code.waitForExist({ timeout: TIMEOUT.normal });
    await code.setValue('123456');
    await $('.unlock .primary.full').click(); // "Verify (1 left)"
    await $('.vault').waitForExist({ timeout: TIMEOUT.slow });
    expect(await $('.vault').isExisting()).to.equal(true);
  });
});
