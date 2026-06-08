/**
 * Security report — the audit overlay loads the offline health report (score,
 * band, summary stats) and closes again.
 */
import { expect } from 'chai';
import { $ } from '@wdio/globals';
import { domClickByTitle, gotoVault } from '../helpers/app.ts';
import { TIMEOUT, waitFor } from '../helpers/wait.ts';

describe('security report', () => {
  it('opens the audit overlay and shows the health score', async () => {
    await gotoVault();
    await domClickByTitle('Security report');
    await $('.audit').waitForExist({ timeout: TIMEOUT.slow });
    await $('.audit-score-value').waitForExist({ timeout: TIMEOUT.slow });
    expect(await $('.audit-score-value').getText()).to.equal('72');
  });

  it('renders the summary stats', async () => {
    await gotoVault();
    await domClickByTitle('Security report');
    await $('.audit-summary').waitForExist({ timeout: TIMEOUT.slow });
    const stats = await $('.audit-summary').getText();
    // Total logins fixture is 3.
    expect(stats).to.contain('Logins');
    expect(stats).to.contain('3');
  });

  it('closes the audit overlay', async () => {
    await gotoVault();
    await domClickByTitle('Security report');
    await $('.audit').waitForExist({ timeout: TIMEOUT.slow });
    await domClickByTitle('Close');
    await waitFor(async () => !(await $('.audit').isExisting()), 'audit overlay did not close');
  });
});
