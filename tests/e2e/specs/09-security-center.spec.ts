/**
 * Security center — opened from the rail, the overview tab shows the offline
 * health score + summary; tabs switch between overview / exposed / dark-web.
 */
import { expect } from 'chai';
import { $, $$ } from '@wdio/globals';
import { gotoSecurity } from '../helpers/app.ts';
import { TIMEOUT, waitFor } from '../helpers/wait.ts';

describe('security center', () => {
  it('opens from the rail and shows the health score', async () => {
    await gotoSecurity();
    expect(await $('.sec-header').getText()).to.contain('security');
    await $('.sec-score-value').waitForExist({ timeout: TIMEOUT.slow });
    expect(await $('.sec-score-value').getText()).to.equal('72');
  });

  it('renders the summary stats', async () => {
    await gotoSecurity();
    await $('.sec-summary').waitForExist({ timeout: TIMEOUT.slow });
    expect(await $('.sec-summary').getText()).to.contain('3'); // totalLogins fixture
  });

  it('exposes overview / exposed / dark-web tabs', async () => {
    await gotoSecurity();
    await waitFor(async () => (await $$('.sec-tab').length) >= 2, 'security tabs did not render');
    const tabs = await $$('.sec-tab');
    // Switching to a non-overview tab keeps the security view mounted.
    await tabs[1].click();
    expect(await $('.sec-header').isExisting()).to.equal(true);
  });
});
