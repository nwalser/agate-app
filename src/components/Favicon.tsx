// A website favicon for a login row. Tries the site's /favicon.ico, then its
// apple-touch-icon, then gives up and renders the provided fallback (the item's
// type icon). The working/failed outcome per host is remembered (see
// state/favicons.ts) so subsequent renders skip dead ends. Fetched directly by
// the webview from the site — no third-party icon service.

import { createEffect, createSignal, on, Show, type JSX } from 'solid-js';
import { appleUrl, faviconStatus, hostOf, icoUrl, setFaviconStatus } from '../state/favicons.ts';

type Attempt = 'ico' | 'apple' | 'done';

export default function Favicon(props: {
  uri: string | null;
  fallback: JSX.Element;
  size?: number;
}) {
  const host = () => hostOf(props.uri);
  const [attempt, setAttempt] = createSignal<Attempt>('ico');

  // Seed (and reset on host change) from the remembered per-host outcome.
  createEffect(
    on(host, (h) => {
      const known = h ? faviconStatus(h) : undefined;
      setAttempt(known === 'apple' ? 'apple' : known === 'none' ? 'done' : 'ico');
    }),
  );

  const src = () => {
    const h = host();
    if (!h) return null;
    if (attempt() === 'ico') return icoUrl(h);
    if (attempt() === 'apple') return appleUrl(h);
    return null;
  };

  const onError = () => {
    const h = host();
    if (!h) return;
    if (attempt() === 'ico') {
      setAttempt('apple');
    } else {
      setFaviconStatus(h, 'none');
      setAttempt('done');
    }
  };

  const onLoad = () => {
    const h = host();
    if (h) setFaviconStatus(h, attempt() === 'apple' ? 'apple' : 'ico');
  };

  const size = () => props.size ?? 16;

  return (
    <Show when={src()} fallback={props.fallback}>
      <img
        class="favicon-img"
        src={src() ?? undefined}
        width={size()}
        height={size()}
        alt=""
        loading="lazy"
        referrerpolicy="no-referrer"
        onError={onError}
        onLoad={onLoad}
      />
    </Show>
  );
}
