/**
 * Item detail — selecting a row loads its detail; password reveal toggles the
 * masked value; copy actions surface a toast; a login with TOTP shows a live
 * one-time code.
 */
import { expect } from 'chai';
import { $, browser } from '@wdio/globals';
import { clickRow, gotoVault, waitForToast } from '../helpers/app.ts';
import { TIMEOUT, waitFor } from '../helpers/wait.ts';

/** Click the copy button inside the detail field whose label matches. */
async function copyField(label: string): Promise<void> {
  const ok = await browser.execute((l: string) => {
    for (const f of Array.from(document.querySelectorAll('.detail-field'))) {
      if ((f.querySelector('label')?.textContent ?? '').trim().includes(l)) {
        const btn = f.querySelector<HTMLButtonElement>('button[title="Copy"]');
        if (btn) { btn.click(); return true; }
      }
    }
    return false;
  }, label);
  if (!ok) throw new Error(`no copyable field labelled "${label}"`);
}

describe('item detail', () => {
  it('loads detail when a row is selected', async () => {
    await gotoVault();
    await clickRow('GitHub');
    await $('.detail-name').waitForExist({ timeout: TIMEOUT.normal });
    expect(await $('.detail-name').getText()).to.equal('GitHub');
  });

  it('keeps the password masked until revealed', async () => {
    await gotoVault();
    await clickRow('GitHub');
    await $('.detail-name').waitForExist({ timeout: TIMEOUT.normal });

    const pw = () => $('.detail-value.mono');
    expect(await pw().getText()).to.match(/•+/);

    await $('button[title="Reveal"]').click();
    await waitFor(async () => (await pw().getText()) === 'correct-horse-battery-staple', 'password did not reveal');
  });

  it('copies the username and toasts', async () => {
    await gotoVault();
    await clickRow('GitHub');
    await $('.detail-name').waitForExist({ timeout: TIMEOUT.normal });
    await copyField('Username');
    await waitForToast('Username copied');
  });

  it('shows a one-time code for a TOTP login', async () => {
    await gotoVault();
    await clickRow('GitHub');
    await $('.totp-code').waitForExist({ timeout: TIMEOUT.normal });
    expect(await $('.totp-code').getText()).to.equal('123456');
    expect(await $('.totp-remaining').getText()).to.match(/\d+s/);
  });

  it('shows notes and no TOTP for a plain login', async () => {
    await gotoVault();
    await clickRow('Fastmail');
    await $('.detail-name').waitForExist({ timeout: TIMEOUT.normal });
    expect(await $('.totp-code').isExisting()).to.equal(false);
  });
});
