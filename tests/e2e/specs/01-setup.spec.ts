/**
 * First-run app-unlock setup — create the single app password that unlocks every
 * connection. Validates length + match, then advances into the app.
 */
import { expect } from 'chai';
import { $, $$ } from '@wdio/globals';
import { gotoSetup, setAppPassword, clickButtonByText, waitForToast } from '../helpers/app.ts';
import { TIMEOUT } from '../helpers/wait.ts';

describe('app-unlock setup (first run)', () => {
  it('shows the setup screen with two password fields', async () => {
    await gotoSetup();
    expect(await $('.onboarding-brand').getText()).to.contain('Agate');
    expect(await $$('.onboarding input[type="password"]').length).to.equal(2);
  });

  it('rejects a password shorter than 8 chars', async () => {
    await gotoSetup();
    const pw = await $$('.onboarding input[type="password"]');
    await pw[0].setValue('short');
    await pw[1].setValue('short');
    await clickButtonByText('Set app password');
    await waitForToast('at least 8 characters');
  });

  it('rejects mismatched passwords', async () => {
    await gotoSetup();
    const pw = await $$('.onboarding input[type="password"]');
    await pw[0].setValue('correcthorse');
    await pw[1].setValue('differenthorse');
    await clickButtonByText('Set app password');
    await waitForToast('do not match');
  });

  it('sets the app password and advances into the app', async () => {
    await gotoSetup();
    await setAppPassword('correcthorse');
    // configure_app_unlock unlocks → vault (empty, no connections yet).
    await $('.vault').waitForExist({ timeout: TIMEOUT.slow });
    expect(await $('.vault').isExisting()).to.equal(true);
  });
});
