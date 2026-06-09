// Reusable password / passphrase generator popover. Owns its own option signals
// and open/close state, talks to the backend generators through `ipc`, and hands
// the generated string back via `onGenerated`. Reuses the editor's `.ie-gen-*`
// CSS classes (the parent imports ItemEditor.css), so it must render inside that
// scope to pick them up.
import { createSignal, Show } from 'solid-js';
import { Dices } from 'lucide-solid';
import { ipc } from '../lib/ipc.ts';
import { toastError } from '../state/toast.ts';

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
      props.onGenerated(result);
      setGenOpen(false);
    } catch (err) {
      toastError(err);
    }
  }

  return (
    <div class="ie-gen-anchor">
      <button
        class="ghost icon-btn"
        title="Generate"
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
              Password
            </button>
            <button
              classList={{ active: genMode() === 'passphrase' }}
              onClick={() => setGenMode('passphrase')}
            >
              Passphrase
            </button>
          </div>

          <Show
            when={genMode() === 'password'}
            fallback={
              <div class="ie-gen-opts">
                <div class="field">
                  <label>Words: {genWords()}</label>
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
                  <label>Separator</label>
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
                  Capitalize
                </label>
                <label class="ie-check">
                  <input
                    type="checkbox"
                    checked={genWordNumber()}
                    onChange={(e) =>
                      setGenWordNumber(e.currentTarget.checked)
                    }
                  />
                  Include number
                </label>
              </div>
            }
          >
            <div class="ie-gen-opts">
              <div class="field">
                <label>Length: {genLength()}</label>
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
                A–Z
              </label>
              <label class="ie-check">
                <input
                  type="checkbox"
                  checked={genLower()}
                  onChange={(e) => setGenLower(e.currentTarget.checked)}
                />
                a–z
              </label>
              <label class="ie-check">
                <input
                  type="checkbox"
                  checked={genNumbers()}
                  onChange={(e) => setGenNumbers(e.currentTarget.checked)}
                />
                0–9
              </label>
              <label class="ie-check">
                <input
                  type="checkbox"
                  checked={genSpecial()}
                  onChange={(e) => setGenSpecial(e.currentTarget.checked)}
                />
                !@#$
              </label>
            </div>
          </Show>

          <button class="primary ie-gen-go" onClick={() => void generate()}>
            Generate &amp; use
          </button>
        </div>
      </Show>
    </div>
  );
}
