// Standalone password / passphrase generator page (reached from the sidebar).
//
// Both modes call the backend generators (which work without an unlocked vault).
// Output regenerates automatically as options change; Copy and Regenerate are the
// two primary actions.

import { createEffect, createSignal, Match, Show, Switch } from 'solid-js';
import { Copy, RefreshCw } from 'lucide-solid';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { ipc } from '../lib/ipc.ts';
import type { PassphraseGenOptions, PasswordGenOptions } from '../lib/types.ts';
import { pushToast, toastError } from '../state/toast.ts';
import { pushGeneratorHistory } from '../state/generatorHistory.ts';
import './GeneratorPage.css';

type Mode = 'password' | 'passphrase';

export default function GeneratorPage() {
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

  function setPw<K extends keyof PasswordGenOptions>(key: K, value: PasswordGenOptions[K]) {
    setPwOpts({ ...pwOpts(), [key]: value });
  }
  function setPp<K extends keyof PassphraseGenOptions>(key: K, value: PassphraseGenOptions[K]) {
    setPpOpts({ ...ppOpts(), [key]: value });
  }

  const noCharSet = () => {
    const o = pwOpts();
    return !(o.uppercase || o.lowercase || o.numbers || o.special);
  };

  async function generate() {
    try {
      if (mode() === 'password') {
        if (noCharSet()) {
          setOutput('');
          return;
        }
        setOutput(await ipc.generatePassword(pwOpts()));
      } else {
        setOutput(await ipc.generatePassphrase(ppOpts()));
      }
    } catch (err) {
      toastError(err);
    }
  }

  // Regenerate whenever the mode or the active mode's options change.
  createEffect(() => {
    mode();
    if (mode() === 'password') pwOpts();
    else ppOpts();
    void generate();
  });

  async function copy() {
    if (!output()) return;
    try {
      await writeText(output());
      // Copying is an intentional "I want this value" — record it (unlike the
      // auto-regenerate effect, which would flood history on every slider tick).
      pushGeneratorHistory(output());
      pushToast('success', 'Copied.');
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
        <h2>Generator</h2>
      </header>

      <div class="generator-body">
        <div class="generator-mode">
          <button
            class="generator-mode-btn"
            classList={{ active: mode() === 'password' }}
            onClick={() => setMode('password')}
          >
            Password
          </button>
          <button
            class="generator-mode-btn"
            classList={{ active: mode() === 'passphrase' }}
            onClick={() => setMode('passphrase')}
          >
            Passphrase
          </button>
        </div>

        <div class="generator-output">
          <code class="generator-value mono">
            <Show when={output()} fallback={<span class="muted">Pick at least one character set.</span>}>
              {output()}
            </Show>
          </code>
          <button class="ghost icon-btn" title="Regenerate" onClick={() => void regenerate()}>
            <RefreshCw size={15} strokeWidth={1.75} />
          </button>
          <button class="ghost icon-btn" title="Copy" disabled={!output()} onClick={() => void copy()}>
            <Copy size={15} strokeWidth={1.75} />
          </button>
        </div>

        <Switch>
          <Match when={mode() === 'password'}>
            <section class="generator-options">
              <div class="field">
                <label>Length: {pwOpts().length}</label>
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
                  <input type="checkbox" checked={pwOpts().uppercase} onChange={(e) => setPw('uppercase', e.currentTarget.checked)} /> A-Z
                </label>
                <label class="checkbox">
                  <input type="checkbox" checked={pwOpts().lowercase} onChange={(e) => setPw('lowercase', e.currentTarget.checked)} /> a-z
                </label>
                <label class="checkbox">
                  <input type="checkbox" checked={pwOpts().numbers} onChange={(e) => setPw('numbers', e.currentTarget.checked)} /> 0-9
                </label>
                <label class="checkbox">
                  <input type="checkbox" checked={pwOpts().special} onChange={(e) => setPw('special', e.currentTarget.checked)} /> !@#
                </label>
                <label class="checkbox">
                  <input
                    type="checkbox"
                    checked={pwOpts().avoidAmbiguous ?? false}
                    onChange={(e) => setPw('avoidAmbiguous', e.currentTarget.checked)}
                  /> Avoid ambiguous
                </label>
              </div>
            </section>
          </Match>
          <Match when={mode() === 'passphrase'}>
            <section class="generator-options">
              <div class="field">
                <label>Words: {ppOpts().numWords}</label>
                <input
                  type="range"
                  min="3"
                  max="20"
                  value={ppOpts().numWords}
                  onInput={(e) => setPp('numWords', Number(e.currentTarget.value))}
                />
              </div>
              <div class="field">
                <label>Separator</label>
                <input
                  class="generator-sep"
                  maxlength="5"
                  value={ppOpts().wordSeparator}
                  onInput={(e) => setPp('wordSeparator', e.currentTarget.value)}
                />
              </div>
              <div class="generator-toggles">
                <label class="checkbox">
                  <input type="checkbox" checked={ppOpts().capitalize} onChange={(e) => setPp('capitalize', e.currentTarget.checked)} /> Capitalize
                </label>
                <label class="checkbox">
                  <input type="checkbox" checked={ppOpts().includeNumber} onChange={(e) => setPp('includeNumber', e.currentTarget.checked)} /> Include number
                </label>
              </div>
            </section>
          </Match>
        </Switch>
      </div>
    </div>
  );
}
