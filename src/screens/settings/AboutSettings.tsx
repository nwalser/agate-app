// Settings › About — version + the unofficial-client disclaimer.

import { createSignal, onMount, Show } from 'solid-js';
import { getVersion } from '@tauri-apps/api/app';
import { ShieldCheck } from 'lucide-solid';

export default function AboutSettings() {
  const [version, setVersion] = createSignal('');

  onMount(() => {
    void getVersion()
      .then(setVersion)
      .catch(() => {
        // ignore: version is informational; leave it blank if the host can't report it
      });
  });

  return (
    <div class="settings-page">
      <section class="settings-section settings-about">
        <div class="settings-about-brand">
          <ShieldCheck size={22} strokeWidth={1.75} />
          <div>
            <div class="settings-about-name">Agate</div>
            <Show when={version()}>
              <div class="muted settings-about-version">Version {version()}</div>
            </Show>
          </div>
        </div>
        <p class="muted settings-help">
          An unofficial, open-source desktop client for Bitwarden, built on Bitwarden's official Rust
          SDK. Not affiliated with or endorsed by Bitwarden, Inc. "Bitwarden" is a trademark of
          Bitwarden, Inc.
        </p>
        <p class="muted settings-foot">Agate · unofficial Bitwarden client · GPL-3.0</p>
      </section>
    </div>
  );
}
