/**
 * Generator — the standalone password/passphrase page reached from the sidebar.
 * Auto-generates on open and on mode switch; output comes from the fake backend.
 */
import { expect } from 'chai';
import { $ } from '@wdio/globals';
import { clickButtonByText, gotoVault } from '../helpers/app.ts';
import { TIMEOUT, waitFor } from '../helpers/wait.ts';

async function generatorValue(): Promise<string> {
  return $('.generator-value').getText();
}

describe('generator page', () => {
  it('opens from the sidebar and auto-generates a password', async () => {
    await gotoVault();
    await clickButtonByText('Generator');
    await $('.generator').waitForExist({ timeout: TIMEOUT.normal });
    await waitFor(
      async () => (await generatorValue()).includes('Xq7!vPz2@Lm9'),
      'generator did not produce the fixture password',
      TIMEOUT.normal,
    );
  });

  it('switches to passphrase mode and regenerates', async () => {
    await gotoVault();
    await clickButtonByText('Generator');
    await $('.generator').waitForExist({ timeout: TIMEOUT.normal });
    await clickButtonByText('Passphrase');
    await waitFor(
      async () => (await generatorValue()).includes('amber-tractor-vivid-9'),
      'generator did not produce the fixture passphrase',
      TIMEOUT.normal,
    );
  });
});
