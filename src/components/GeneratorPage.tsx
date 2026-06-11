// Standalone password / passphrase generator page (reached from the sidebar).
//
// Both modes call the backend generators (which work without an unlocked vault).
// Output regenerates automatically as options change; Copy and Regenerate are the
// two primary actions.

import { createEffect, createSignal, For, Match, Show, Switch } from 'solid-js';
import { Copy, RefreshCw } from 'lucide-solid';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { ipc } from '../lib/ipc.ts';
import type {
  PassphraseGenOptions,
  PasswordGenOptions,
  UsernameGenOptions,
  UsernameMode,
} from '../lib/types.ts';
import { pushToast, toastError } from '../state/toast.ts';
import { pushGeneratorHistory } from '../state/generatorHistory.ts';
import { t } from '../lib/i18n.ts';
import './GeneratorPage.css';

type Mode = 'password' | 'passphrase' | 'username';

export default function GeneratorPage() {
  // Built inside render (called via the For below) so the labels re-translate
  // when the language flips; the ids stay stable English union values.
  const usernameModes = (): { id: UsernameMode; label: string }[] => [
    { id: 'plusAddressed', label: t('generator.usernameModePlusAddressed') },
    { id: 'catchAll', label: t('generator.usernameModeCatchAll') },
    { id: 'random', label: t('generator.usernameModeRandom') },
  ];
  const [mode, setMode] = createSignal<Mode>('password');
  const [output, setOutput] = createSignal('');

  const [pwOpts, setPwOpts] = createSignal<PasswordGenOptions>({
    length: 16,
    uppercase: true,
    lowercase: true,
    numbers: true,
    special: true,
    avoidAmbiguous: false,
  });
  const [ppOpts, setPpOpts] = createSignal<PassphraseGenOptions>({
    numWords: 4,
    wordSeparator: '-',
    capitalize: true,
    includeNumber: true,
  });
  const [unOpts, setUnOpts] = createSignal<UsernameGenOptions>({
    mode: 'plusAddressed',
    email: '',
    domain: '',
  });

  function setPw<K extends keyof PasswordGenOptions>(key: K, value: PasswordGenOptions[K]) {
    setPwOpts({ ...pwOpts(), [key]: value });
  }
  function setPp<K extends keyof PassphraseGenOptions>(key: K, value: PassphraseGenOptions[K]) {
    setPpOpts({ ...ppOpts(), [key]: value });
  }
  function setUn<K extends keyof UsernameGenOptions>(key: K, value: UsernameGenOptions[K]) {
    setUnOpts({ ...unOpts(), [key]: value });
  }

  const noCharSet = () => {
    const o = pwOpts();
    return !(o.uppercase || o.lowercase || o.numbers || o.special);
  };

  // Whether the username inputs are complete enough to generate (so the backend
  // isn't called with an empty email/domain and made to toast an error).
  const usernameReady = () => {
    const o = unOpts();
    if (o.mode === 'plusAddressed') return /.+@.+/.test((o.email ?? '').trim());
    if (o.mode === 'catchAll') return /.+\..+/.test((o.domain ?? '').trim());
    return true;
  };

  async function generate() {
    try {
      if (mode() === 'password') {
        if (noCharSet()) {
          setOutput('');
          return;
        }
        setOutput(await ipc.generatePassword(pwOpts()));
      } else if (mode() === 'passphrase') {
        setOutput(await ipc.generatePassphrase(ppOpts()));
      } else {
        if (!usernameReady()) {
          setOutput('');
          return;
        }
        setOutput(await ipc.generateUsername(unOpts()));
      }
    } catch (err) {
      toastError(err);
    }
  }

  // Regenerate whenever the mode or the active mode's options change.
  createEffect(() => {
    const m = mode();
    if (m === 'password') pwOpts();
    else if (m === 'passphrase') ppOpts();
    else unOpts();
    void generate();
  });

  async function copy() {
    if (!output()) return;
    try {
      await writeText(output());
      // Copying is an intentional "I want this value" — record it (unlike the
      // auto-regenerate effect, which would flood history on every slider tick).
      pushGeneratorHistory(output());
      pushToast('success', t('common.copied'));
    } catch (err) {
      toastError(err);
    }
  }

  // Explicit "make me a new one" — generate, then record the result.
  async function regenerate() {
    await generate();
    pushGeneratorHistory(output());
  }

  return (
    <div class="generator">
      <header class="generator-header">
        <h2>{t('generator.title')}</h2>
      </header>

      <div class="generator-body">
        <div class="generator-mode">
          <button
            class="generator-mode-btn"
            classList={{ active: mode() === 'password' }}
            onClick={() => setMode('password')}
          >
            {t('generator.password')}
          </button>
          <button
            class="generator-mode-btn"
            classList={{ active: mode() === 'passphrase' }}
            onClick={() => setMode('passphrase')}
          >
            {t('generator.passphrase')}
          </button>
          <button
            class="generator-mode-btn"
            classList={{ active: mode() === 'username' }}
            onClick={() => setMode('username')}
          >
            {t('generator.username')}
          </button>
        </div>

        <div class="generator-output">
          <code class="generator-value mono">
            <Show
              when={output()}
              fallback={
                <span class="muted">
                  {mode() === 'username'
                    ? t('generator.emptyUsername')
                    : t('generator.emptyCharset')}
                </span>
              }
            >
              {output()}
            </Show>
          </code>
          <button class="ghost icon-btn" title={t('generator.regenerate')} onClick={() => void regenerate()}>
            <RefreshCw size={15} strokeWidth={1.75} />
          </button>
          <button class="ghost icon-btn" title={t('common.copy')} disabled={!output()} onClick={() => void copy()}>
            <Copy size={15} strokeWidth={1.75} />
          </button>
        </div>

        <Switch>
          <Match when={mode() === 'password'}>
            <section class="generator-options">
              <div class="field">
                <label>{t('generator.lengthLabel', { count: pwOpts().length })}</label>
                <input
                  type="range"
                  min="5"
                  max="128"
                  value={pwOpts().length}
                  onInput={(e) => setPw('length', Number(e.currentTarget.value))}
                />
              </div>
              <div class="generator-toggles">
                <label class="checkbox">
                  <input type="checkbox" checked={pwOpts().uppercase} onChange={(e) => setPw('uppercase', e.currentTarget.checked)} /> {t('generator.charsetUpperAscii')}
                </label>
                <label class="checkbox">
                  <input type="checkbox" checked={pwOpts().lowercase} onChange={(e) => setPw('lowercase', e.currentTarget.checked)} /> {t('generator.charsetLowerAscii')}
                </label>
                <label class="checkbox">
                  <input type="checkbox" checked={pwOpts().numbers} onChange={(e) => setPw('numbers', e.currentTarget.checked)} /> {t('generator.charsetNumbersAscii')}
                </label>
                <label class="checkbox">
                  <input type="checkbox" checked={pwOpts().special} onChange={(e) => setPw('special', e.currentTarget.checked)} /> {t('generator.charsetSpecial')}
                </label>
                <label class="checkbox">
                  <input
                    type="checkbox"
                    checked={pwOpts().avoidAmbiguous ?? false}
                    onChange={(e) => setPw('avoidAmbiguous', e.currentTarget.checked)}
                  /> {t('generator.avoidAmbiguous')}
                </label>
              </div>
            </section>
          </Match>
          <Match when={mode() === 'passphrase'}>
            <section class="generator-options">
              <div class="field">
                <label>{t('generator.wordsLabel', { count: ppOpts().numWords })}</label>
                <input
                  type="range"
                  min="3"
                  max="20"
                  value={ppOpts().numWords}
                  onInput={(e) => setPp('numWords', Number(e.currentTarget.value))}
                />
              </div>
              <div class="field">
                <label>{t('generator.separator')}</label>
                <input
                  class="generator-sep"
                  maxlength="5"
                  value={ppOpts().wordSeparator}
                  onInput={(e) => setPp('wordSeparator', e.currentTarget.value)}
                />
              </div>
              <div class="generator-toggles">
                <label class="checkbox">
                  <input type="checkbox" checked={ppOpts().capitalize} onChange={(e) => setPp('capitalize', e.currentTarget.checked)} /> {t('generator.capitalize')}
                </label>
                <label class="checkbox">
                  <input type="checkbox" checked={ppOpts().includeNumber} onChange={(e) => setPp('includeNumber', e.currentTarget.checked)} /> {t('generator.includeNumber')}
                </label>
              </div>
            </section>
          </Match>
          <Match when={mode() === 'username'}>
            <section class="generator-options">
              <div class="generator-mode generator-submode">
                <For each={usernameModes()}>
                  {(m) => (
                    <button
                      class="generator-mode-btn"
                      classList={{ active: unOpts().mode === m.id }}
                      onClick={() => setUn('mode', m.id)}
                    >
                      {m.label}
                    </button>
                  )}
                </For>
              </div>
              <Switch>
                <Match when={unOpts().mode === 'plusAddressed'}>
                  <div class="field">
                    <label>{t('generator.baseEmail')}</label>
                    <input
                      placeholder="you@example.com"
                      value={unOpts().email ?? ''}
                      onInput={(e) => setUn('email', e.currentTarget.value)}
                    />
                    <p class="muted generator-username-hint">
                      {t('generator.plusAddressedHintBefore')}{' '}
                      <code>you+abc123@example.com</code>{' '}
                      {t('generator.plusAddressedHintAfter')}
                    </p>
                  </div>
                </Match>
                <Match when={unOpts().mode === 'catchAll'}>
                  <div class="field">
                    <label>{t('generator.catchAllDomain')}</label>
                    <input
                      placeholder="example.com"
                      value={unOpts().domain ?? ''}
                      onInput={(e) => setUn('domain', e.currentTarget.value)}
                    />
                    <p class="muted generator-username-hint">
                      {t('generator.catchAllHint')}
                    </p>
                  </div>
                </Match>
                <Match when={unOpts().mode === 'random'}>
                  <p class="muted generator-username-hint">{t('generator.randomHint')}</p>
                </Match>
              </Switch>
            </section>
          </Match>
        </Switch>
      </div>
    </div>
  );
}
