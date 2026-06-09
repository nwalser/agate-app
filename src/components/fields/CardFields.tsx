// Card-type fields: a live card preview plus cardholder / number (with auto
// brand detection) / brand / CVV / expiry inputs. Owns its own signals and
// exposes its CardInput builder to the orchestrator via `onReady`.
import { createMemo, createSignal, For } from 'solid-js';
import { CreditCard, Eye, EyeOff } from 'lucide-solid';
import type { CardInput, ItemDetail } from '../../lib/types.ts';
import { CARD_BRANDS, detectCardBrand, formatCardNumber } from '../../lib/cardBrands.ts';
import { orNull } from './index.ts';

// Month dropdown for card expiry. Values are the bare month number (Bitwarden
// stores expMonth as "1".."12"); the labels stay human.
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
].map((label, idx) => ({
  value: String(idx + 1),
  label: `${String(idx + 1).padStart(2, '0')} — ${label}`,
}));

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

  return (
    <div class="ie-section">
      {/* Live preview of the card as it's typed. */}
      <div class="ie-card-preview">
        <div class="ie-card-row-top">
          <CreditCard size={22} strokeWidth={1.5} />
          <span class="ie-card-brand">{previewBrand() || 'Card'}</span>
        </div>
        <div class="ie-card-number mono">
          {formatCardNumber(cardNumber(), previewBrand()) || '•••• •••• •••• ••••'}
        </div>
        <div class="ie-card-row-bottom">
          <div class="ie-card-meta">
            <span class="ie-card-cap">Cardholder</span>
            <span class="ie-card-val">{cardholderName() || '—'}</span>
          </div>
          <div class="ie-card-meta">
            <span class="ie-card-cap">Expires</span>
            <span class="ie-card-val">
              {expMonth() ? String(expMonth()).padStart(2, '0') : 'MM'}/
              {expYear() ? String(expYear()).slice(-2) : 'YY'}
            </span>
          </div>
        </div>
      </div>

      <div class="field">
        <label>Cardholder name</label>
        <input
          value={cardholderName()}
          onInput={(e) => setCardholderName(e.currentTarget.value)}
          placeholder="Name on card"
        />
      </div>
      <div class="field">
        <label>Card number</label>
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
          <label>Brand</label>
          <select value={cardBrand()} onChange={(e) => setCardBrand(e.currentTarget.value)}>
            <option value="">Auto-detect</option>
            <For each={CARD_BRANDS}>{(b) => <option value={b}>{b}</option>}</For>
          </select>
        </div>
        <div class="field">
          <label>Security code (CVV)</label>
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
              title={revealCode() ? 'Hide' : 'Reveal'}
              onClick={() => setRevealCode(!revealCode())}
            >
              {revealCode() ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </div>
      </div>
      <div class="ie-grid-2">
        <div class="field">
          <label>Expiration month</label>
          <select
            value={expMonth() ? String(Number(expMonth())) : ''}
            onChange={(e) => setExpMonth(e.currentTarget.value)}
          >
            <option value="">—</option>
            <For each={MONTHS}>{(m) => <option value={m.value}>{m.label}</option>}</For>
          </select>
        </div>
        <div class="field">
          <label>Expiration year</label>
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
