// Reusable password / passphrase generator popover. Owns its own option signals
// and open/close state, talks to the backend generators through `ipc`, and hands
// the generated string back via `onGenerated`. Reuses the editor's `.ie-gen-*`
// CSS classes (the parent imports ItemEditor.css), so it must render inside that
// scope to pick them up.
import { createSignal, For, Show } from 'solid-js';
import { Copy, Dices, History, Trash2 } from 'lucide-solid';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { ipc } from '../lib/ipc.ts';
import { t } from '../lib/i18n.ts';
import { toastError } from '../state/toast.ts';
import {
  clearGeneratorHistory,
  generatorHistory,
  pushGeneratorHistory,
} from '../state/generatorHistory.ts';

type GenMode = 'password' | 'passphrase';

export default function PasswordGenerator(props: {
  /** Called with the freshly generated secret; the popover closes itself after. */
  onGenerated: (value: string) => void;
}) {
  const [genOpen, setGenOpen] = createSignal(false);
  const [genMode, setGenMode] = createSignal<GenMode>('password');
  const [genLength, setGenLength] = createSignal(16);
  const [genUpper, setGenUpper] = createSignal(true);
  const [genLower, setGenLower] = createSignal(true);
  const [genNumbers, setGenNumbers] = createSignal(true);
  const [genSpecial, setGenSpecial] = createSignal(true);
  const [genWords, setGenWords] = createSignal(4);
  const [genSeparator, setGenSeparator] = createSignal('-');
  const [genCapitalize, setGenCapitalize] = createSignal(true);
  const [genWordNumber, setGenWordNumber] = createSignal(true);

  async function generate() {
    try {
      let result: string;
      if (genMode() === 'passphrase') {
        result = await ipc.generatePassphrase({
          numWords: genWords(),
          wordSeparator: genSeparator() || '-',
          capitalize: genCapitalize(),
          includeNumber: genWordNumber(),
        });
      } else {
        result = await ipc.generatePassword({
          length: genLength(),
          uppercase: genUpper(),
          lowercase: genLower(),
          numbers: genNumbers(),
          special: genSpecial(),
          avoidAmbiguous: true,
        });
      }
      pushGeneratorHistory(result);
      props.onGenerated(result);
      setGenOpen(false);
    } catch (err) {
      toastError(err);
    }
  }

  // Copy a past value to the clipboard without disturbing the edited field.
  async function copyEntry(value: string) {
    try {
      await writeText(value);
    } catch (err) {
      toastError(err);
    }
  }

  return (
    <div class="ie-gen-anchor">
      <button
        class="ghost icon-btn"
        title={t('generator.generate')}
        onClick={() => setGenOpen(!genOpen())}
      >
        <Dices size={14} />
      </button>
      <Show when={genOpen()}>
        <div class="ie-gen-popover">
          <div class="ie-gen-tabs">
            <button
              classList={{ active: genMode() === 'password' }}
              onClick={() => setGenMode('password')}
            >
              {t('generator.password')}
            </button>
            <button
              classList={{ active: genMode() === 'passphrase' }}
              onClick={() => setGenMode('passphrase')}
            >
              {t('generator.passphrase')}
            </button>
          </div>

          <Show
            when={genMode() === 'password'}
            fallback={
              <div class="ie-gen-opts">
                <div class="field">
                  <label>{t('generator.wordsLabel', { count: genWords() })}</label>
                  <input
                    type="range"
                    min="3"
                    max="10"
                    value={genWords()}
                    onInput={(e) =>
                      setGenWords(Number(e.currentTarget.value))
                    }
                  />
                </div>
                <div class="field">
                  <label>{t('generator.separator')}</label>
                  <input
                    value={genSeparator()}
                    maxlength="1"
                    onInput={(e) => setGenSeparator(e.currentTarget.value)}
                  />
                </div>
                <label class="ie-check">
                  <input
                    type="checkbox"
                    checked={genCapitalize()}
                    onChange={(e) =>
                      setGenCapitalize(e.currentTarget.checked)
                    }
                  />
                  {t('generator.capitalize')}
                </label>
                <label class="ie-check">
                  <input
                    type="checkbox"
                    checked={genWordNumber()}
                    onChange={(e) =>
                      setGenWordNumber(e.currentTarget.checked)
                    }
                  />
                  {t('generator.includeNumber')}
                </label>
              </div>
            }
          >
            <div class="ie-gen-opts">
              <div class="field">
                <label>{t('generator.lengthLabel', { count: genLength() })}</label>
                <input
                  type="range"
                  min="8"
                  max="64"
                  value={genLength()}
                  onInput={(e) => setGenLength(Number(e.currentTarget.value))}
                />
              </div>
              <label class="ie-check">
                <input
                  type="checkbox"
                  checked={genUpper()}
                  onChange={(e) => setGenUpper(e.currentTarget.checked)}
                />
                {t('generator.charsetUpper')}
              </label>
              <label class="ie-check">
                <input
                  type="checkbox"
                  checked={genLower()}
                  onChange={(e) => setGenLower(e.currentTarget.checked)}
                />
                {t('generator.charsetLower')}
              </label>
              <label class="ie-check">
                <input
                  type="checkbox"
                  checked={genNumbers()}
                  onChange={(e) => setGenNumbers(e.currentTarget.checked)}
                />
                {t('generator.charsetNumbers')}
              </label>
              <label class="ie-check">
                <input
                  type="checkbox"
                  checked={genSpecial()}
                  onChange={(e) => setGenSpecial(e.currentTarget.checked)}
                />
                {t('generator.charsetSpecialPw')}
              </label>
            </div>
          </Show>

          <button class="primary ie-gen-go" onClick={() => void generate()}>
            {t('generator.generateAndUse')}
          </button>

          <Show when={generatorHistory().length > 0}>
            <div class="ie-gen-history">
              <div class="ie-gen-history-head">
                <span class="ie-gen-history-title">
                  <History size={12} strokeWidth={1.75} /> {t('generator.recent')}
                </span>
                <button class="ghost icon-btn" title={t('generator.clearHistory')} onClick={() => clearGeneratorHistory()}>
                  <Trash2 size={12} strokeWidth={1.75} />
                </button>
              </div>
              <For each={generatorHistory()}>
                {(entry) => (
                  <div class="ie-gen-history-row">
                    <button
                      class="ie-gen-history-value"
                      title={t('generator.useThisValue')}
                      onClick={() => {
                        props.onGenerated(entry.value);
                        setGenOpen(false);
                      }}
                    >
                      {entry.value}
                    </button>
                    <button class="ghost icon-btn" title={t('common.copy')} onClick={() => void copyEntry(entry.value)}>
                      <Copy size={12} strokeWidth={1.75} />
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}
