/**
 * Connections — Settings lists every configured Bitwarden connection; "add
 * connection" opens the add flow; removing one drops it from the list.
 */
import { expect } from 'chai';
import { $, $$, browser } from '@wdio/globals';
import {
  FIXTURE_EMAIL,
  FIXTURE_LABEL,
  clickButtonByText,
  domClickByTitle,
  gotoSettings,
  unlockedFake,
  waitForToast,
} from '../helpers/app.ts';
import { TIMEOUT, waitFor } from '../helpers/wait.ts';

function twoConnectionFake() {
  return unlockedFake({
    status: {
      appUnlockConfigured: true, unlocked: true, helloConfigured: false,
      darkwebConsent: false, connectionCount: 2, liveCount: 2,
    },
    connections: [
      // storeCredentials false: keeps these specs exercising the "Manual" badge
      // rendering path, as the old (untyped) fixtures implicitly did.
      { email: FIXTURE_EMAIL, serverLabel: FIXTURE_LABEL, server: { region: 'us' }, unlocked: true, storeCredentials: false },
      { email: 'second@example.com', serverLabel: 'Bitwarden — EU', server: { region: 'eu' }, unlocked: true, storeCredentials: false },
    ],
  });
}

async function connectionEmails(): Promise<string[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll('.settings-account .settings-account-info')).map(
      (e) => (e.querySelector('span')?.textContent ?? '').trim(),
    ),
  );
}

describe('connections', () => {
  it('lists every configured connection', async () => {
    await gotoSettings(twoConnectionFake());
    await $('.settings-account').waitForExist({ timeout: TIMEOUT.normal });
    const emails = await connectionEmails();
    expect(emails).to.include(FIXTURE_EMAIL);
    expect(emails).to.include('second@example.com');
  });

  it('opens the add-connection flow', async () => {
    await gotoSettings(twoConnectionFake());
    // The add flow is opened by the "Add connection" button (the old
    // `.add-account` affordance no longer exists).
    await clickButtonByText('Add connection');
    await $('.onboarding').waitForExist({ timeout: TIMEOUT.normal });
    expect(await $('.onboarding input[type="email"]').getValue()).to.equal('');
  });

  it('removes a connection', async () => {
    await gotoSettings(twoConnectionFake());
    await $('.settings-account').waitForExist({ timeout: TIMEOUT.normal });
    await domClickByTitle('Remove connection');
    await waitForToast('Connection removed');
    await waitFor(async () => (await $$('.settings-account').length) === 1, 'connection was not removed');
  });
});
