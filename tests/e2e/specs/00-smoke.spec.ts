/**
 * Smoke — verify webdriver attaches to the app DOM and the test-only IPC seam is
 * present (without it, every other spec can't drive the UI). Prints what the
 * session is attached to so boot failures are diagnosable.
 */
import { expect } from 'chai';
import { browser } from '@wdio/globals';
import { attachToApp } from '../helpers/app.ts';

describe('smoke', () => {
  it('attaches to the agate window and exposes the e2e IPC seam', async () => {
    await attachToApp();

    const info = await browser.execute(() => ({
      title: document.title,
      url: location.href,
      readyState: document.readyState,
      hasMount: !!document.getElementById('app'),
      hasInvokeSeam: typeof (window as unknown as { __agateInvoke?: unknown }).__agateInvoke === 'object',
      hasRefreshSeam:
        typeof (window as unknown as { __agateRefreshSession?: unknown }).__agateRefreshSession === 'function',
    }));

    // eslint-disable-next-line no-console
    console.log('SMOKE ►', JSON.stringify(info, null, 2));

    expect(info.hasMount, 'app mount root #app').to.equal(true);
    expect(info.hasInvokeSeam, '__agateInvoke seam present (build with TAURI_ENV_DEBUG)').to.equal(true);
    expect(info.hasRefreshSeam, '__agateRefreshSession seam present').to.equal(true);
  });
});
