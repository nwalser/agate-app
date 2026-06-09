/**
 * Security center — opened from the rail. A single-page dashboard (no tabs):
 * vault-health summary + every security section stacked and visible at once.
 * There is no rolled-up 0–100 score; the per-flag breakdown is the signal.
 */
import { expect } from 'chai';
import { $ } from '@wdio/globals';
import { gotoSecurity } from '../helpers/app.ts';
import { TIMEOUT } from '../helpers/wait.ts';

describe('security center', () => {
  it('opens from the rail and shows the vault-health summary', async () => {
    await gotoSecurity();
    expect(await $('.sec-header').getText()).to.contain('security');
    await $('.sec-summary').waitForExist({ timeout: TIMEOUT.slow });
    // No single rolled-up score is rendered anymore.
    expect(await $('.sec-score-value').isExisting()).to.equal(false);
  });

  it('renders the summary stats', async () => {
    await gotoSecurity();
    await $('.sec-summary').waitForExist({ timeout: TIMEOUT.slow });
    expect(await $('.sec-summary').getText()).to.contain('3'); // totalLogins fixture
  });

  it('stacks every security section on one page (no tabs)', async () => {
    await gotoSecurity();
    await $('.sec-summary').waitForExist({ timeout: TIMEOUT.slow });
    const body = await $('.sec-body').getText();
    expect(body).to.contain('Exposed passwords');
    expect(body).to.contain('Dark web monitor');
    expect(body).to.contain('Breaches affecting you');
  });
});
