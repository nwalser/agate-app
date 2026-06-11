// SSH-key-type fields: private key, public key, fingerprint. Owns its own
// signals and exposes its SshKeyInput builder to the orchestrator via `onReady`.
import { createSignal } from 'solid-js';
import type { ItemDetail, SshKeyInput } from '../../lib/types.ts';
import { t } from '../../lib/i18n.ts';

export default function SshKeyFields(props: {
  item?: ItemDetail | null;
  onReady: (build: () => SshKeyInput) => void;
}) {
  // (prefilled from ItemDetail.sshKey)
  const sk = () => props.item?.sshKey ?? null;
  const [privateKey, setPrivateKey] = createSignal(sk()?.privateKey ?? '');
  const [publicKey, setPublicKey] = createSignal(sk()?.publicKey ?? '');
  const [fingerprint, setFingerprint] = createSignal(sk()?.fingerprint ?? '');

  function buildSshKey(): SshKeyInput {
    return {
      privateKey: privateKey(),
      publicKey: publicKey(),
      fingerprint: fingerprint(),
    };
  }
  props.onReady(buildSshKey);

  return (
    <div class="ie-section">
      <div class="field">
        <label>{t('fields.privateKey')}</label>
        <textarea
          class="ie-textarea ie-mono"
          value={privateKey()}
          onInput={(e) => setPrivateKey(e.currentTarget.value)}
          rows="5"
          autocomplete="off"
        />
      </div>
      <div class="field">
        <label>{t('fields.publicKey')}</label>
        <textarea
          class="ie-textarea ie-mono"
          value={publicKey()}
          onInput={(e) => setPublicKey(e.currentTarget.value)}
          rows="3"
        />
      </div>
      <div class="field">
        <label>{t('fields.fingerprint')}</label>
        <input
          class="ie-mono"
          value={fingerprint()}
          onInput={(e) => setFingerprint(e.currentTarget.value)}
        />
      </div>
    </div>
  );
}
