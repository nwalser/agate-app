/**
 * Onboarding — server selection, the self-hosted URL field, input validation,
 * saved-connection recall, and a successful login that lands in the vault.
 */
import { expect } from 'chai';
import { $ } from '@wdio/globals';
import {
  FIXTURE_EMAIL,
  fillLogin,
  gotoOnboarding,
  loggedOutFake,
  submitLogin,
  toastMessages,
  waitForToast,
} from '../helpers/app.ts';
import { TIMEOUT } from '../helpers/wait.ts';

describe('onboarding / login', () => {
  it('shows the brand and a login form by default', async () => {
    await gotoOnboarding();
    expect(await $('.onboarding-brand').getText()).to.contain('Agate');
    expect(await $('.onboarding input[type="email"]').isExisting()).to.equal(true);
    expect(await $('.onboarding input[type="password"]').isExisting()).to.equal(true);
  });

  it('reveals the Server URL field only for self-hosted', async () => {
    await gotoOnboarding();
    const urlField = () => $('.onboarding input[placeholder="https://vault.example.com"]');
    expect(await urlField().isExisting()).to.equal(false);

    await $('.onboarding select').selectByAttribute('value', 'selfHosted');
    await urlField().waitForExist({ timeout: TIMEOUT.normal });
    expect(await urlField().isExisting()).to.equal(true);
  });

  it('rejects an empty submit with a validation toast', async () => {
    await gotoOnboarding();
    await submitLogin();
    await waitForToast('Enter your email and master password');
  });

  it('logs in and lands in the vault', async () => {
    await gotoOnboarding(loggedOutFake());
    await fillLogin(FIXTURE_EMAIL, 'master-pw');
    await submitLogin();
    await $('.vault').waitForExist({ timeout: TIMEOUT.slow });
    expect(await $('.vault').isExisting()).to.equal(true);
  });

  it('offers saved connections and prefills email when one is picked', async () => {
    await gotoOnboarding(
      loggedOutFake({
        accounts: [
          {
            email: 'saved@example.com',
            serverLabel: 'Self-hosted — vault.example.com',
            server: { region: 'selfHosted', baseUrl: 'https://vault.example.com' },
            active: false,
          },
        ],
      }),
    );
    await $('.onboarding-connection').waitForExist({ timeout: TIMEOUT.normal });
    await $('.onboarding-connection').click();
    expect(await $('.onboarding input[type="email"]').getValue()).to.equal('saved@example.com');
    // Picking a self-hosted connection switches the server + fills the URL.
    expect(
      await $('.onboarding input[placeholder="https://vault.example.com"]').getValue(),
    ).to.equal('https://vault.example.com');
  });

  it('surfaces a backend login error as a toast (vault stays closed)', async () => {
    await gotoOnboarding(
      loggedOutFake({ errors: { login: { kind: 'invalidCredentials', message: 'Invalid master password.' } } }),
    );
    await fillLogin(FIXTURE_EMAIL, 'wrong');
    await submitLogin();
    await waitForToast('Invalid master password');
    expect(await $('.vault').isExisting()).to.equal(false);
    expect(await toastMessages()).to.not.be.empty;
  });
});
