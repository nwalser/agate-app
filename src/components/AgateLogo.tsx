// The Agate brand mark: a gem shield with a keyhole, the same silhouette as the
// app icon (src-tauri/icons/source.svg). Single-color via `currentColor` so it
// inherits the surrounding text/icon color like a lucide icon; the keyhole is
// true negative space (whatever sits behind the svg shows through). Use this for
// every in-app brand spot — never re-draw the mark inline.

import type { JSX } from 'solid-js';

// Per-instance mask id: multiple logos on one screen must not share an id.
let seq = 0;

export function AgateLogo(props: { size?: number; class?: string }): JSX.Element {
  const id = `agate-logo-${seq++}`;
  const size = (): number => props.size ?? 24;
  return (
    <svg
      width={size()}
      height={size()}
      viewBox="0 0 1024 1024"
      class={props.class}
      aria-hidden="true"
    >
      <mask id={id} maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024">
        <rect width="1024" height="1024" fill="black" />
        <path
          d="M276 268 L748 268 C762 512 690 700 512 808 C334 700 262 512 276 268 Z"
          fill="white"
        />
        <circle cx="512" cy="450" r="86" fill="black" />
        <path d="M466 498 L450 656 L574 656 L558 498 Z" fill="black" />
      </mask>
      <rect width="1024" height="1024" fill="currentColor" mask={`url(#${id})`} />
    </svg>
  );
}
