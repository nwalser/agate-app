/**
 * Command palette — Ctrl/Cmd-K opens it, typing filters the commands, Enter runs
 * the top match, and Escape closes it. Exercises the lock and settings commands.
 */
import { expect } from 'chai';
import { $, $$, browser } from '@wdio/globals';
import { gotoVault } from '../helpers/app.ts';
import { TIMEOUT, waitFor } from '../helpers/wait.ts';

async function openPalette(): Promise<void> {
  await browser.keys(['Control', 'k']);
  await $('.cmdp-panel').waitForDisplayed({ timeout: TIMEOUT.normal });
}

describe('command palette', () => {
  it('opens with Ctrl-K and lists commands', async () => {
    await gotoVault();
    await openPalette();
    expect(await $('.cmdp-input').isDisplayed()).to.equal(true);
    await waitFor(async () => (await $$('.cmdp-item').length) > 0, 'palette listed no commands');
  });

  it('filters commands by query', async () => {
    await gotoVault();
    await openPalette();
    await $('.cmdp-input').setValue('lock vault');
    await waitFor(async () => (await $$('.cmdp-item').length) >= 1, 'no command matched "lock vault"');
    const first = await $('.cmdp-item').getText();
    expect(first.toLowerCase()).to.contain('lock');
  });

  it('closes on Escape', async () => {
    await gotoVault();
    await openPalette();
    await browser.keys(['Escape']);
    await waitFor(async () => !(await $('.cmdp-panel').isExisting()), 'palette did not close on Escape');
  });

  it('runs the Lock command and locks the vault', async () => {
    await gotoVault();
    await openPalette();
    await $('.cmdp-input').setValue('lock vault');
    await waitFor(async () => (await $$('.cmdp-item').length) >= 1, 'no lock command');
    await browser.keys(['Enter']);
    await $('.unlock').waitForExist({ timeout: TIMEOUT.slow });
    expect(await $('.unlock').isExisting()).to.equal(true);
  });

  it('runs the Settings command', async () => {
    await gotoVault();
    await openPalette();
    await $('.cmdp-input').setValue('open settings');
    await waitFor(async () => (await $$('.cmdp-item').length) >= 1, 'no settings command');
    await browser.keys(['Enter']);
    await $('.settings').waitForExist({ timeout: TIMEOUT.slow });
    expect(await $('.settings').isExisting()).to.equal(true);
  });
});
