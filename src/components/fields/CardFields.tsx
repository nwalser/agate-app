// Card-type fields: a live card preview plus cardholder / number (with auto
// brand detection) / brand / CVV / expiry inputs. Owns its own signals and
// exposes its CardInput builder to the orchestrator via `onReady`. "Scan card"
// OCRs the screen (or a picked image) and prefills the recognized fields —
// number only when Luhn-valid, CVV never (see lib/cardOcr.ts).
import { createMemo, createSignal, For, onMount, Show } from 'solid-js';
import { CreditCard, Eye, EyeOff, ImageUp, ScanLine } from 'lucide-solid';
import type { CardInput, ItemDetail } from '../../lib/types.ts';
import { CARD_BRANDS, detectCardBrand, formatCardNumber } from '../../lib/cardBrands.ts';
import { parseCardFromOcr } from '../../lib/cardOcr.ts';
import { ipc } from '../../lib/ipc.ts';
import { pushToast, toastError } from '../../state/toast.ts';
import { t } from '../../lib/i18n.ts';
import { orNull } from './index.ts';

// Month dropdown for card expiry. Values are the bare month number (Bitwarden
// stores expMonth as "1".."12"); the labels stay human. Built in render (not at
// module scope) so the month names stay reactive to a language flip.
const MONTH_KEYS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
function months() {
  return MONTH_KEYS.map((key, idx) => ({
    value: String(idx + 1),
    label: `${String(idx + 1).padStart(2, '0')} — ${t('fields.month.' + key)}`,
  }));
}

export default function CardFields(props: {
  item?: ItemDetail | null;
  onReady: (build: () => CardInput) => void;
}) {
  // (prefilled from ItemDetail.card so edits don't wipe it)
  const c = () => props.item?.card ?? null;
  const [cardholderName, setCardholderName] = createSignal(c()?.cardholderName ?? '');
  const [cardNumber, setCardNumber] = createSignal(c()?.number ?? '');
  const [cardBrand, setCardBrand] = createSignal(c()?.brand ?? '');
  const [expMonth, setExpMonth] = createSignal(c()?.expMonth ?? '');
  const [expYear, setExpYear] = createSignal(c()?.expYear ?? '');
  const [cardCode, setCardCode] = createSignal(c()?.code ?? '');
  const [revealCode, setRevealCode] = createSignal(false);
  // Effective brand for the preview: the chosen brand, else a live guess.
  const previewBrand = createMemo(() => cardBrand() || detectCardBrand(cardNumber()) || '');

  // Set the card number and auto-fill the brand when it's still blank, so a
  // pasted number picks its own brand without clobbering a manual choice.
  function onCardNumberInput(v: string) {
    setCardNumber(v);
    if (!cardBrand()) {
      const guess = detectCardBrand(v);
      if (guess) setCardBrand(guess);
    }
  }

  function buildCard(): CardInput {
    return {
      cardholderName: orNull(cardholderName()),
      number: orNull(cardNumber()),
      brand: orNull(cardBrand()),
      expMonth: orNull(expMonth()),
      expYear: orNull(expYear()),
      code: orNull(cardCode()),
    };
  }
  props.onReady(buildCard);

  // ── Scan card (OCR): screen capture or a picked image → prefill fields. ──
  // Hidden where the platform has no OCR engine (non-Windows for now).
  const [ocrAvailable, setOcrAvailable] = createSignal(false);
  const [scanning, setScanning] = createSignal(false);
  onMount(() => {
    void (async () => {
      try {
        setOcrAvailable(await ipc.ocrAvailable());
      } catch {
        // ignore: probe failure just keeps the scan buttons hidden
      }
    })();
  });

  function applyParsed(lines: string[]) {
    const parsed = parseCardFromOcr(lines);
    if (parsed.confidence === 'none') {
      pushToast('error', t('fields.cardNothingRecognized'));
      return;
    }
    let filled = 0;
    if (parsed.number) {
      onCardNumberInput(parsed.number); // keeps the existing brand auto-fill
      filled++;
    }
    if (parsed.expMonth) {
      setExpMonth(parsed.expMonth);
      filled++;
    }
    if (parsed.expYear) {
      setExpYear(parsed.expYear);
      filled++;
    }
    if (parsed.cardholderName) {
      setCardholderName(parsed.cardholderName);
      filled++;
    }
    // Never echo the parsed number itself — count only.
    pushToast('success', t('fields.filledFromScan', { count: filled }));
  }

  async function scanCard(source: 'screen' | 'file') {
    if (scanning()) return;
    setScanning(true);
    try {
      const lines = source === 'screen' ? await ipc.ocrCaptureScreen() : await ipc.ocrCaptureFile();
      if (lines === null) return; // file picker cancelled
      applyParsed(lines);
    } catch (err) {
      toastError(err);
    } finally {
      setScanning(false);
    }
  }

  return (
    <div class="ie-section">
      <Show when={ocrAvailable()}>
        <div class="ie-section-title ie-card-scan-row">
          <button
            class="ghost ie-add ie-scan-qr"
            disabled={scanning()}
            onClick={() => void scanCard('screen')}
            title={t('fields.scanCardTooltip')}
          >
            <ScanLine size={13} strokeWidth={1.75} /> {t('fields.scanCard')}
          </button>
          <button
            class="ghost ie-add ie-scan-qr"
            disabled={scanning()}
            onClick={() => void scanCard('file')}
            title={t('fields.fromImageCardTooltip')}
          >
            <ImageUp size={13} strokeWidth={1.75} /> {t('fields.fromImage')}
          </button>
        </div>
      </Show>

      {/* Live preview of the card as it's typed. */}
      <div class="ie-card-preview">
        <div class="ie-card-row-top">
          <CreditCard size={22} strokeWidth={1.5} />
          <span class="ie-card-brand">{previewBrand() || t('fields.card')}</span>
        </div>
        <div class="ie-card-number mono">
          {formatCardNumber(cardNumber(), previewBrand()) || '•••• •••• •••• ••••'}
        </div>
        <div class="ie-card-row-bottom">
          <div class="ie-card-meta">
            <span class="ie-card-cap">{t('fields.cardholder')}</span>
            <span class="ie-card-val">{cardholderName() || '—'}</span>
          </div>
          <div class="ie-card-meta">
            <span class="ie-card-cap">{t('fields.expires')}</span>
            <span class="ie-card-val">
              {expMonth() ? String(expMonth()).padStart(2, '0') : 'MM'}/
              {expYear() ? String(expYear()).slice(-2) : 'YY'}
            </span>
          </div>
        </div>
      </div>

      <div class="field">
        <label>{t('fields.cardholderName')}</label>
        <input
          value={cardholderName()}
          onInput={(e) => setCardholderName(e.currentTarget.value)}
          placeholder={t('fields.nameOnCard')}
        />
      </div>
      <div class="field">
        <label>{t('fields.cardNumber')}</label>
        <input
          class="ie-mono"
          value={cardNumber()}
          onInput={(e) => onCardNumberInput(e.currentTarget.value)}
          placeholder="0000 0000 0000 0000"
          inputmode="numeric"
          autocomplete="off"
        />
      </div>
      <div class="ie-grid-2">
        <div class="field">
          <label>{t('fields.brand')}</label>
          <select value={cardBrand()} onChange={(e) => setCardBrand(e.currentTarget.value)}>
            <option value="">{t('fields.autoDetect')}</option>
            <For each={CARD_BRANDS}>{(b) => <option value={b}>{b}</option>}</For>
          </select>
        </div>
        <div class="field">
          <label>{t('fields.securityCode')}</label>
          <div class="row ie-pw-row">
            <input
              class="ie-grow ie-mono"
              type={revealCode() ? 'text' : 'password'}
              value={cardCode()}
              onInput={(e) => setCardCode(e.currentTarget.value)}
              placeholder="•••"
              inputmode="numeric"
              autocomplete="off"
            />
            <button
              class="ghost icon-btn"
              title={revealCode() ? t('common.hide') : t('fields.reveal')}
              onClick={() => setRevealCode(!revealCode())}
            >
              {revealCode() ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </div>
      </div>
      <div class="ie-grid-2">
        <div class="field">
          <label>{t('fields.expirationMonth')}</label>
          <select
            value={expMonth() ? String(Number(expMonth())) : ''}
            onChange={(e) => setExpMonth(e.currentTarget.value)}
          >
            <option value="">—</option>
            <For each={months()}>{(m) => <option value={m.value}>{m.label}</option>}</For>
          </select>
        </div>
        <div class="field">
          <label>{t('fields.expirationYear')}</label>
          <input
            value={expYear()}
            onInput={(e) => setExpYear(e.currentTarget.value)}
            placeholder="YYYY"
            inputmode="numeric"
          />
        </div>
      </div>
    </div>
  );
}
