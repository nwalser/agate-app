/**
 * Multiple accounts — the Settings accounts list shows every remembered account,
 * "add another" opens a blank login, removing one drops it, and switching clears
 * the session (routing to the target account's unlock).
 */
import { expect } from 'chai';
import { $, $$, browser } from '@wdio/globals';
import {
  FIXTURE_EMAIL,
  domClickByTitle,
  gotoSettings,
  unlockedFake,
  waitForToast,
} from '../helpers/app.ts';
import { TIMEOUT, waitFor } from '../helpers/wait.ts';

function twoAccountFake() {
  return unlockedFake({
    accounts: [
      { email: FIXTURE_EMAIL, serverLabel: 'Bitwarden — US', server: { region: 'us' }, active: true },
      { email: 'second@example.com', serverLabel: 'Bitwarden — EU', server: { region: 'eu' }, active: false },
    ],
  });
}

async function accountEmails(): Promise<string[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll('.settings-account .settings-account-info')).map(
      (e) => (e.querySelector('span')?.textContent ?? '').trim(),
    ),
  );
}

describe('multiple accounts', () => {
  it('lists every remembered account', async () => {
    await gotoSettings(twoAccountFake());
    await $('.settings-account').waitForExist({ timeout: TIMEOUT.normal });
    const emails = await accountEmails();
    expect(emails).to.include(FIXTURE_EMAIL);
    expect(emails).to.include('second@example.com');
  });

  it('opens a blank login via "add another account"', async () => {
    await gotoSettings(twoAccountFake());
    await $('.add-account').click();
    await $('.onboarding').waitForExist({ timeout: TIMEOUT.normal });
    expect(await $('.onboarding input[type="email"]').getValue()).to.equal('');
  });

  it('removes a non-active account', async () => {
    await gotoSettings(twoAccountFake());
    await $('.settings-account').waitForExist({ timeout: TIMEOUT.normal });
    // The second (inactive) account exposes a Remove button.
    await domClickByTitle('Remove account');
    await waitForToast('Account removed');
    await waitFor(
      async () => (await $$('.settings-account').length) === 1,
      'account row was not removed',
    );
  });

  it('switching accounts clears the session and routes to unlock', async () => {
    await gotoSettings(twoAccountFake());
    await $('.settings-account').waitForExist({ timeout: TIMEOUT.normal });
    await domClickByTitle('Switch to this account');
    await $('.unlock').waitForExist({ timeout: TIMEOUT.slow });
    expect(await $('.unlock').isExisting()).to.equal(true);
  });
});
