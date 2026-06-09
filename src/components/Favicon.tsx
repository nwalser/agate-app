// A website favicon for a login row. Tries the site's /favicon.ico, then its
// apple-touch-icon; if neither exists it walks up to the registrable domain
// (so login.example.com falls back to example.com), and only then gives up and
// renders the provided fallback (the item's type icon). The working/failed
// outcome per host is remembered (see state/favicons.ts) so subsequent renders
// skip dead ends. Fetched directly by the webview from the site — no
// third-party icon service.

import { createEffect, createSignal, on, Show, type JSX } from 'solid-js';
import {
  appleUrl,
  faviconStatus,
  hostOf,
  icoUrl,
  parentHost,
  setFaviconStatus,
} from '../state/favicons.ts';

type Attempt = 'ico' | 'apple';

/** Skip past hosts already known to have no icon, toward the domain. */
function firstViable(host: string | null): string | null {
  let h = host;
  while (h && faviconStatus(h) === 'none') h = parentHost(h);
  return h;
}

export default function Favicon(props: {
  uri: string | null;
  fallback: JSX.Element;
  size?: number;
}) {
  const initialHost = () => hostOf(props.uri);
  const [host, setHost] = createSignal<string | null>(null);
  const [attempt, setAttempt] = createSignal<Attempt>('ico');

  // Seed (and reset on URI change) at the first host with a chance of an icon,
  // starting from the remembered per-host outcome.
  createEffect(
    on(initialHost, (h) => {
      const start = firstViable(h);
      setHost(start);
      setAttempt(start && faviconStatus(start) === 'apple' ? 'apple' : 'ico');
    }),
  );

  const src = () => {
    const h = host();
    if (!h) return null;
    return attempt() === 'apple' ? appleUrl(h) : icoUrl(h);
  };

  const onError = () => {
    const h = host();
    if (!h) return;
    if (attempt() === 'ico') {
      setAttempt('apple');
      return;
    }
    // Both icons failed for this host: remember it, then fall back to the
    // registrable domain (skipping any known dead ends), else give up.
    setFaviconStatus(h, 'none');
    const next = firstViable(parentHost(h));
    setHost(next);
    setAttempt(next && faviconStatus(next) === 'apple' ? 'apple' : 'ico');
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
