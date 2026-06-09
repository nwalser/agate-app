/**
 * Audit settings — Settings › Audits lets you enable/disable each offline security
 * check and tune its threshold. The config is a local UI preference (no backend
 * call to toggle), so this drives the real reactive UI via the fake-backed app.
 */
import { expect } from 'chai';
import { $, $$ } from '@wdio/globals';
import { domClickByTitle, gotoSettings } from '../helpers/app.ts';
import { TIMEOUT } from '../helpers/wait.ts';

describe('audit settings', () => {
  it('lists the audit checks with toggles', async () => {
    await gotoSettings();
    await domClickByTitle('Audits');
    await $('.audit-check').waitForExist({ timeout: TIMEOUT.normal });
    expect(await $$('.audit-check').length).to.be.greaterThan(3);
    expect(await $$('.audit-switch').length).to.be.greaterThan(3);
  });

  it('toggles a check off', async () => {
    await gotoSettings();
    await domClickByTitle('Audits');
    await $('.audit-check').waitForExist({ timeout: TIMEOUT.normal });
    // The config persists in localStorage across spec relaunches, so normalize to
    // defaults first — otherwise a prior run's toggle leaks into these assertions.
    await $('.audit-reset').click();
    const firstSwitch = await $('.audit-switch');
    expect(await firstSwitch.getAttribute('aria-checked')).to.equal('true');
    // Reused is on by default → its threshold select is shown.
    expect(await $('.audit-threshold select').isExisting()).to.equal(true);
    await firstSwitch.click();
    expect(await firstSwitch.getAttribute('aria-checked')).to.equal('false');
  });
});
