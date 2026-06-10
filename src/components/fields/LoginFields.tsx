// Login-type fields: username, password (with reveal + a generator popover and a
// live strength meter), TOTP key (with on-screen QR scan), and the repeatable
// URI rows with their match-detection dropdown. Owns its own signals and exposes
// its LoginInput builder to the orchestrator via `onReady`. "From image" OCRs a
// picked image and prefills the unambiguous bits (email → username, URL → uri).
import { createMemo, createSignal, For, onMount, Show } from 'solid-js';
import { Eye, EyeOff, ImageUp, Plus, QrCode, Trash2 } from 'lucide-solid';
import { ipc } from '../../lib/ipc.ts';
import type { ItemDetail, LoginInput, UriInput } from '../../lib/types.ts';
import { MATCH_OPTIONS } from '../../lib/uriMatching.ts';
import { mapOcrToLogin } from '../../lib/ocrFill.ts';
import { pushToast, toastError } from '../../state/toast.ts';
import PasswordGenerator from '../PasswordGenerator.tsx';
import { orNull } from './index.ts';

interface UriRow {
  uri: string;
  matchType: number | null;
}

// Lightweight password-strength heuristic (0–4) for the login editor's meter.
// Not a security control — just feedback while typing.
function passwordStrength(pw: string): { score: number; label: string } {
  if (!pw) return { score: 0, label: '' };
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 14) score++;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  if (classes >= 2) score++;
  if (classes >= 3 && pw.length >= 10) score++;
  score = Math.min(score, 4);
  return { score, label: ['', 'Weak', 'Fair', 'Good', 'Strong'][score] };
}

export default function LoginFields(props: {
  item?: ItemDetail | null;
  /** Past usernames across the vault, offered as autocomplete on the field. */
  usernames?: string[];
  onReady: (build: () => LoginInput) => void;
}) {
  const [username, setUsername] = createSignal(props.item?.login?.username ?? '');
  const [password, setPassword] = createSignal(props.item?.login?.password ?? '');
  const [revealPw, setRevealPw] = createSignal(false);
  // Prefill the real TOTP secret so an edit preserves it (backend also guards).
  const [totp, setTotp] = createSignal(props.item?.login?.totp ?? '');
  const [scanningQr, setScanningQr] = createSignal(false);
  const [uris, setUris] = createSignal<UriRow[]>(
    (props.item?.login?.uris ?? []).map((u) => ({
      uri: u.uri ?? '',
      matchType: u.matchType ?? null,
    })),
  );
  const strength = createMemo(() => passwordStrength(password()));

  // ---- uri rows ----
  function addUri() {
    setUris((prev) => [...prev, { uri: '', matchType: null }]);
  }
  function removeUri(index: number) {
    setUris((prev) => prev.filter((_, i) => i !== index));
  }
  function updateUri(index: number, patch: Partial<UriRow>) {
    setUris((prev) => prev.map((u, i) => (i === index ? { ...u, ...patch } : u)));
  }

  // Grab a TOTP setup QR off the screen (any monitor) and drop its otpauth:// URI
  // into the field. Capture + decode happen in Rust; we only receive the URI.
  async function scanTotpQr() {
    if (scanningQr()) return;
    setScanningQr(true);
    try {
      const uri = await ipc.scanTotpQr();
      setTotp(uri);
      pushToast('success', 'TOTP key captured from screen.');
    } catch (err) {
      toastError(err);
    } finally {
      setScanningQr(false);
    }
  }

  // ── Fill from image (OCR): email → username, URL → a uri row. Conservative —
  // only fills what's blank; the recognized text is never logged. Hidden where
  // the platform has no OCR engine.
  const [ocrAvailable, setOcrAvailable] = createSignal(false);
  const [ocrBusy, setOcrBusy] = createSignal(false);
  onMount(() => {
    void (async () => {
      try {
        setOcrAvailable(await ipc.ocrAvailable());
      } catch {
        // ignore: probe failure just keeps the button hidden
      }
    })();
  });
  async function fillFromImage() {
    if (ocrBusy()) return;
    setOcrBusy(true);
    try {
      const lines = await ipc.ocrCaptureFile();
      if (lines === null) return; // cancelled
      const m = mapOcrToLogin(lines);
      let filled = 0;
      if (m.username && !username().trim()) {
        setUsername(m.username);
        filled++;
      }
      if (m.uri && !uris().some((u) => u.uri.trim())) {
        setUris((prev) => [...prev.filter((u) => u.uri.trim()), { uri: m.uri!, matchType: null }]);
        filled++;
      }
      if (filled === 0) pushToast('error', 'Nothing usable recognized in that image.');
      else pushToast('success', `Filled ${filled} field${filled === 1 ? '' : 's'} from the image.`);
    } catch (err) {
      toastError(err);
    } finally {
      setOcrBusy(false);
    }
  }

  function buildLogin(): LoginInput {
    const uriInputs: UriInput[] = uris()
      .filter((u) => u.uri.trim().length > 0)
      .map((u) => ({ uri: orNull(u.uri), matchType: u.matchType }));
    return {
      username: orNull(username()),
      password: orNull(password()),
      totp: orNull(totp()),
      uris: uriInputs,
    };
  }
  props.onReady(buildLogin);

  return (
    <div class="ie-section">
      <div class="ie-section-title ie-title-row">
        Login credentials
        <Show when={ocrAvailable()}>
          <button
            class="ghost ie-add ie-scan-qr"
            disabled={ocrBusy()}
            onClick={() => void fillFromImage()}
            title="Read username/website from an image file"
          >
            <ImageUp size={13} strokeWidth={1.75} /> From image
          </button>
        </Show>
      </div>
      <div class="field">
        <label>Username</label>
        <input
          value={username()}
          onInput={(e) => setUsername(e.currentTarget.value)}
          list="ie-username-suggestions"
          autocomplete="off"
        />
        <Show when={props.usernames && props.usernames.length > 0}>
          <datalist id="ie-username-suggestions">
            <For each={props.usernames}>{(u) => <option value={u} />}</For>
          </datalist>
        </Show>
      </div>

      <div class="field">
        <label>Password</label>
        <div class="row ie-pw-row">
          <input
            class="ie-grow ie-mono"
            type={revealPw() ? 'text' : 'password'}
            value={password()}
            onInput={(e) => setPassword(e.currentTarget.value)}
            autocomplete="off"
          />
          <button
            class="ghost icon-btn"
            title={revealPw() ? 'Hide' : 'Reveal'}
            onClick={() => setRevealPw(!revealPw())}
          >
            {revealPw() ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
          <PasswordGenerator
            onGenerated={(value) => {
              setPassword(value);
              setRevealPw(true);
            }}
          />
        </div>
        <Show when={password().length > 0}>
          <div class="ie-strength" data-score={strength().score}>
            <div class="ie-strength-bar">
              <span />
              <span />
              <span />
              <span />
            </div>
            <span class="ie-strength-label">{strength().label}</span>
          </div>
        </Show>
      </div>

      <div class="field">
        <label>Authenticator key (TOTP)</label>
        <div class="row ie-totp-row">
          <input
            class="ie-grow"
            value={totp()}
            onInput={(e) => setTotp(e.currentTarget.value)}
            placeholder="otpauth:// or secret"
            autocomplete="off"
          />
          <button
            type="button"
            class="ghost ie-add ie-scan-qr"
            disabled={scanningQr()}
            onClick={() => void scanTotpQr()}
            title="Scan a TOTP QR code shown on your screen"
          >
            <QrCode size={13} strokeWidth={1.75} />
            {scanningQr() ? 'Scanning…' : 'Scan QR'}
          </button>
        </div>
      </div>

      <div class="field">
        <div class="ie-section-head">
          <label>URIs</label>
          <button class="ghost ie-add" onClick={addUri}>
            <Plus size={13} strokeWidth={1.75} /> Add URI
          </button>
        </div>
        <For each={uris()}>
          {(u, i) => (
            <div class="row ie-multi-row">
              <input
                class="ie-grow"
                value={u.uri}
                placeholder="https://example.com"
                onInput={(e) => updateUri(i(), { uri: e.currentTarget.value })}
              />
              <select
                class="ie-match"
                value={String(u.matchType)}
                onChange={(e) => {
                  const v = e.currentTarget.value;
                  updateUri(i(), { matchType: v === 'null' ? null : Number(v) });
                }}
              >
                <For each={MATCH_OPTIONS}>
                  {(opt) => (
                    <option value={opt.value === null ? 'null' : String(opt.value)}>
                      {opt.label}
                    </option>
                  )}
                </For>
              </select>
              <button
                class="ghost icon-btn"
                title="Remove"
                onClick={() => removeUri(i())}
              >
                <Trash2 size={14} />
              </button>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
