// Tray-popup generator view: password / passphrase / username generation inside
// the 380px quick-access popup. A compact port of components/GeneratorPage.tsx —
// same backend calls, same options and defaults, same auto-regenerate-on-change
// behavior — restyled for the tray surface (see TrayGenerator.css).
//
// Copies go through copyWithAutoClear (the ONE clipboard path: animated feedback
// + clipboard wipe for secrets) and are recorded in the in-memory generator
// history, exactly like the main-window generator.

import { createEffect, createSignal, For, Match, Show, Switch, type JSX } from 'solid-js';
import { ArrowLeft, RefreshCw, Dices } from 'lucide-solid';
import { ipc } from '../../lib/ipc.ts';
import type {
  PassphraseGenOptions,
  PasswordGenOptions,
  UsernameGenOptions,
  UsernameMode,
} from '../../lib/types.ts';
import { toastError } from '../../state/toast.ts';
import { pushGeneratorHistory } from '../../state/generatorHistory.ts';
import { copyWithAutoClear } from '../../lib/clipboard.ts';
import CopyButton from '../../components/CopyButton.tsx';
import { t } from '../../lib/i18n.ts';
import './TrayGenerator.css';

type Mode = 'password' | 'passphrase' | 'username';

export default function TrayGenerator(props: { onBack: () => void }): JSX.Element {
  // Built inside render so the labels re-translate when the language flips;
  // the ids stay stable English union values (same pattern as GeneratorPage).
  const modes = (): { id: Mode; label: string }[] => [
    { id: 'password', label: t('generator.password') },
    { id: 'passphrase', label: t('generator.passphrase') },
    { id: 'username', label: t('generator.username') },
  ];
  const usernameModes = (): { id: UsernameMode; label: string }[] => [
    { id: 'plusAddressed', label: t('generator.usernameModePlusAddressed') },
    { id: 'catchAll', label: t('generator.usernameModeCatchAll') },
    { id: 'random', label: t('generator.usernameModeRandom') },
  ];

  const [mode, setMode] = createSignal<Mode>('password');
  const [output, setOutput] = createSignal('');

  // Same options + defaults as the main-window GeneratorPage (which keeps them
  // in-memory only — generator options are deliberately not persisted).
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

  // Auto-generate on open and whenever the mode or the active mode's options
  // change (the effect tracks only the active mode's option signal).
  createEffect(() => {
    const m = mode();
    if (m === 'password') pwOpts();
    else if (m === 'passphrase') ppOpts();
    else unOpts();
    void generate();
  });

  async function copy() {
    if (!output()) return;
    // Copying is an intentional "I want this value" — record it (unlike the
    // auto-regenerate effect, which would flood history on every slider tick).
    pushGeneratorHistory(output());
    // The single copy path: feedback + (for a generated password) auto-clear.
    // A generated username is non-secret, so it never clears.
    await copyWithAutoClear(mode() === 'username' ? 'Username' : 'Password', output());
  }

  // Explicit "make me a new one" — generate, then record the result.
  async function regenerate() {
    await generate();
    pushGeneratorHistory(output());
  }

  return (
    <div class="tray-gen">
      <div class="tray-gen-head">
        <button class="tray-gen-back" title={t('common.back')} onClick={() => props.onBack()}>
          <ArrowLeft size={14} />
        </button>
        <Dices size={14} />
        <span class="tray-gen-title">{t('generator.title')}</span>
      </div>

      <div class="tray-gen-body">
        <div class="tray-gen-mode" role="tablist">
          <For each={modes()}>
            {(m) => (
              <button
                class="tray-gen-mode-btn"
                role="tab"
                aria-selected={mode() === m.id}
                classList={{ active: mode() === m.id }}
                onClick={() => setMode(m.id)}
              >
                {m.label}
              </button>
            )}
          </For>
        </div>

        <div class="tray-gen-output">
          <code class="tray-gen-value">
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
          <div class="tray-gen-output-actions">
            <button
              class="tray-gen-iconbtn"
              title={t('generator.regenerate')}
              onClick={() => void regenerate()}
            >
              <RefreshCw size={14} strokeWidth={1.75} />
            </button>
            <CopyButton
              class="tray-gen-iconbtn"
              size={14}
              disabled={!output()}
              onCopy={() => copy()}
            />
          </div>
        </div>

        <Switch>
          <Match when={mode() === 'password'}>
            <section class="tray-gen-options">
              <div class="tray-gen-field">
                <label>{t('generator.lengthLabel', { count: pwOpts().length })}</label>
                <input
                  type="range"
                  min="5"
                  max="128"
                  value={pwOpts().length}
                  onInput={(e) => setPw('length', Number(e.currentTarget.value))}
                />
              </div>
              <div class="tray-gen-toggles">
                <label class="tray-gen-check">
                  <input
                    type="checkbox"
                    checked={pwOpts().uppercase}
                    onChange={(e) => setPw('uppercase', e.currentTarget.checked)}
                  />{' '}
                  {t('generator.charsetUpperAscii')}
                </label>
                <label class="tray-gen-check">
                  <input
                    type="checkbox"
                    checked={pwOpts().lowercase}
                    onChange={(e) => setPw('lowercase', e.currentTarget.checked)}
                  />{' '}
                  {t('generator.charsetLowerAscii')}
                </label>
                <label class="tray-gen-check">
                  <input
                    type="checkbox"
                    checked={pwOpts().numbers}
                    onChange={(e) => setPw('numbers', e.currentTarget.checked)}
                  />{' '}
                  {t('generator.charsetNumbersAscii')}
                </label>
                <label class="tray-gen-check">
                  <input
                    type="checkbox"
                    checked={pwOpts().special}
                    onChange={(e) => setPw('special', e.currentTarget.checked)}
                  />{' '}
                  {t('generator.charsetSpecial')}
                </label>
                <label class="tray-gen-check">
                  <input
                    type="checkbox"
                    checked={pwOpts().avoidAmbiguous ?? false}
                    onChange={(e) => setPw('avoidAmbiguous', e.currentTarget.checked)}
                  />{' '}
                  {t('generator.avoidAmbiguous')}
                </label>
              </div>
            </section>
          </Match>
          <Match when={mode() === 'passphrase'}>
            <section class="tray-gen-options">
              <div class="tray-gen-field">
                <label>{t('generator.wordsLabel', { count: ppOpts().numWords })}</label>
                <input
                  type="range"
                  min="3"
                  max="20"
                  value={ppOpts().numWords}
                  onInput={(e) => setPp('numWords', Number(e.currentTarget.value))}
                />
              </div>
              <div class="tray-gen-field">
                <label>{t('generator.separator')}</label>
                <input
                  class="tray-gen-sep"
                  maxlength="5"
                  value={ppOpts().wordSeparator}
                  onInput={(e) => setPp('wordSeparator', e.currentTarget.value)}
                />
              </div>
              <div class="tray-gen-toggles">
                <label class="tray-gen-check">
                  <input
                    type="checkbox"
                    checked={ppOpts().capitalize}
                    onChange={(e) => setPp('capitalize', e.currentTarget.checked)}
                  />{' '}
                  {t('generator.capitalize')}
                </label>
                <label class="tray-gen-check">
                  <input
                    type="checkbox"
                    checked={ppOpts().includeNumber}
                    onChange={(e) => setPp('includeNumber', e.currentTarget.checked)}
                  />{' '}
                  {t('generator.includeNumber')}
                </label>
              </div>
            </section>
          </Match>
          <Match when={mode() === 'username'}>
            <section class="tray-gen-options">
              <div class="tray-gen-mode tray-gen-submode" role="tablist">
                <For each={usernameModes()}>
                  {(m) => (
                    <button
                      class="tray-gen-mode-btn"
                      role="tab"
                      aria-selected={unOpts().mode === m.id}
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
                  <div class="tray-gen-field">
                    <label>{t('generator.baseEmail')}</label>
                    <input
                      placeholder="you@example.com"
                      autocomplete="off"
                      value={unOpts().email ?? ''}
                      onInput={(e) => setUn('email', e.currentTarget.value)}
                    />
                    <p class="muted tray-gen-hint">
                      {t('generator.plusAddressedHintBefore')}{' '}
                      <code>you+abc123@example.com</code> {t('generator.plusAddressedHintAfter')}
                    </p>
                  </div>
                </Match>
                <Match when={unOpts().mode === 'catchAll'}>
                  <div class="tray-gen-field">
                    <label>{t('generator.catchAllDomain')}</label>
                    <input
                      placeholder="example.com"
                      autocomplete="off"
                      value={unOpts().domain ?? ''}
                      onInput={(e) => setUn('domain', e.currentTarget.value)}
                    />
                    <p class="muted tray-gen-hint">{t('generator.catchAllHint')}</p>
                  </div>
                </Match>
                <Match when={unOpts().mode === 'random'}>
                  <p class="muted tray-gen-hint">{t('generator.randomHint')}</p>
                </Match>
              </Switch>
            </section>
          </Match>
        </Switch>
      </div>
    </div>
  );
}
