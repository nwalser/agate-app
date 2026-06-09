// Browser-style back/forward for the vault. A createEffect records every distinct
// location the user lands on (see lib/navHistory.ts); back()/forward() restore a
// recorded location by handing it to `apply` inside a batch so the several signal
// writes settle as one — which re-emits that location, which the stack dedups, so
// walking the history never corrupts it. The input bindings (mouse side buttons,
// Alt+Arrow) live in the Vault screen and just call back()/forward().

import { type Accessor, batch, createEffect } from 'solid-js';
import { createNavStack, navLocationEq, type NavLocation } from '../lib/navHistory.ts';

export function useNavigationHistory(deps: {
  current: Accessor<NavLocation>;
  apply: (loc: NavLocation) => void;
}) {
  const stack = createNavStack(navLocationEq);

  createEffect(() => stack.record(deps.current()));

  function go(loc: NavLocation | null) {
    if (!loc) return;
    batch(() => deps.apply(loc));
  }

  return {
    back: () => go(stack.back()),
    forward: () => go(stack.forward()),
    canBack: stack.canBack,
    canForward: stack.canForward,
  };
}

export type NavigationHistory = ReturnType<typeof useNavigationHistory>;
