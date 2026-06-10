/**
 * Layout regression — the titlebar must NEVER scroll away. The document itself
 * can't scroll (#app clips); on short windows each screen scrolls INSIDE its own
 * container so the content stays reachable. Guards the Onboarding/Unlock fix
 * (flex-centering + document scroll let tall cards push the topbar off-screen).
 */
import { expect } from 'chai';
import { $, browser } from '@wdio/globals';
import { gotoSetup, gotoUnlock, gotoVault } from '../helpers/app.ts';
import { TIMEOUT } from '../helpers/wait.ts';

/** True when the document itself has no scroll range (the #app clip works). */
async function documentDoesNotScroll(): Promise<boolean> {
  return browser.execute(
    () => document.documentElement.scrollHeight <= document.documentElement.clientHeight + 1,
  );
}

/** The titlebar's top edge, after an aggressive wheel-scroll attempt. */
async function titlebarTopAfterScroll(): Promise<number> {
  return browser.execute(() => {
    window.scrollTo(0, 600);
    document.documentElement.scrollTop = 600;
    const bar = document.querySelector('.titlebar');
    return bar ? bar.getBoundingClientRect().top : -1;
  });
}

describe('layout — pinned titlebar on short windows', () => {
  before(async () => {
    await browser.setWindowSize(900, 420);
  });
  after(async () => {
    await browser.setWindowSize(1040, 720);
  });

  it('setup screen: document never scrolls, titlebar stays at the top', async () => {
    await gotoSetup();
    await $('.onboarding').waitForExist({ timeout: TIMEOUT.normal });
    expect(await documentDoesNotScroll()).to.equal(true);
    expect(await titlebarTopAfterScroll()).to.equal(0);
    // The tall card stays reachable by scrolling INSIDE .onboarding.
    const reachable = await browser.execute(() => {
      const el = document.querySelector('.onboarding');
      return el !== null && el.scrollHeight >= el.clientHeight;
    });
    expect(reachable).to.equal(true);
  });

  it('unlock screen: document never scrolls, titlebar stays at the top', async () => {
    await gotoUnlock();
    await $('.unlock').waitForExist({ timeout: TIMEOUT.normal });
    expect(await documentDoesNotScroll()).to.equal(true);
    expect(await titlebarTopAfterScroll()).to.equal(0);
  });

  it('vault screen: document never scrolls, titlebar stays at the top', async () => {
    await gotoVault();
    await $('.vault').waitForExist({ timeout: TIMEOUT.slow });
    expect(await documentDoesNotScroll()).to.equal(true);
    expect(await titlebarTopAfterScroll()).to.equal(0);
  });
});
