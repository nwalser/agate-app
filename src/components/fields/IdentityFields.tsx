// Identity-type fields: personal details + address blocks. Owns its own signals
// and exposes its IdentityInput builder to the orchestrator via `onReady`.
// "From image" OCRs a picked image (e.g. a business card) into the blank
// name/email/phone fields.
import { createSignal, onMount, Show } from 'solid-js';
import { ImageUp } from 'lucide-solid';
import { ipc } from '../../lib/ipc.ts';
import type { IdentityInput, ItemDetail } from '../../lib/types.ts';
import { mapOcrToIdentity } from '../../lib/ocrFill.ts';
import { pushToast, toastError } from '../../state/toast.ts';
import { t } from '../../lib/i18n.ts';
import { orNull } from './index.ts';

export default function IdentityFields(props: {
  item?: ItemDetail | null;
  onReady: (build: () => IdentityInput) => void;
}) {
  // (prefilled from ItemDetail.identity)
  const idd = () => props.item?.identity ?? null;
  const [idTitle, setIdTitle] = createSignal(idd()?.title ?? '');
  const [firstName, setFirstName] = createSignal(idd()?.firstName ?? '');
  const [middleName, setMiddleName] = createSignal(idd()?.middleName ?? '');
  const [lastName, setLastName] = createSignal(idd()?.lastName ?? '');
  const [idUsername, setIdUsername] = createSignal(idd()?.username ?? '');
  const [company, setCompany] = createSignal(idd()?.company ?? '');
  const [ssn, setSsn] = createSignal(idd()?.ssn ?? '');
  const [passportNumber, setPassportNumber] = createSignal(idd()?.passportNumber ?? '');
  const [licenseNumber, setLicenseNumber] = createSignal(idd()?.licenseNumber ?? '');
  const [email, setEmail] = createSignal(idd()?.email ?? '');
  const [phone, setPhone] = createSignal(idd()?.phone ?? '');
  const [address1, setAddress1] = createSignal(idd()?.address1 ?? '');
  const [address2, setAddress2] = createSignal(idd()?.address2 ?? '');
  const [address3, setAddress3] = createSignal(idd()?.address3 ?? '');
  const [city, setCity] = createSignal(idd()?.city ?? '');
  const [stateRegion, setStateRegion] = createSignal(idd()?.state ?? '');
  const [postalCode, setPostalCode] = createSignal(idd()?.postalCode ?? '');
  const [country, setCountry] = createSignal(idd()?.country ?? '');

  function buildIdentity(): IdentityInput {
    return {
      title: orNull(idTitle()),
      firstName: orNull(firstName()),
      middleName: orNull(middleName()),
      lastName: orNull(lastName()),
      username: orNull(idUsername()),
      company: orNull(company()),
      ssn: orNull(ssn()),
      passportNumber: orNull(passportNumber()),
      licenseNumber: orNull(licenseNumber()),
      email: orNull(email()),
      phone: orNull(phone()),
      address1: orNull(address1()),
      address2: orNull(address2()),
      address3: orNull(address3()),
      city: orNull(city()),
      state: orNull(stateRegion()),
      postalCode: orNull(postalCode()),
      country: orNull(country()),
    };
  }
  props.onReady(buildIdentity);

  // ── Fill from image (OCR): name/email/phone into blank fields only. The
  // recognized text is never logged. Hidden where OCR is unavailable.
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
      const m = mapOcrToIdentity(lines);
      let filled = 0;
      const fill = (cur: string, v: string | undefined, set: (s: string) => void) => {
        if (v && !cur.trim()) {
          set(v);
          filled++;
        }
      };
      fill(firstName(), m.firstName, setFirstName);
      fill(lastName(), m.lastName, setLastName);
      fill(email(), m.email, setEmail);
      fill(phone(), m.phone, setPhone);
      if (filled === 0) pushToast('error', t('fields.ocrNothingRecognized'));
      else pushToast('success', t('fields.filledFromImage', { count: filled }));
    } catch (err) {
      toastError(err);
    } finally {
      setOcrBusy(false);
    }
  }

  return (
    <>
      <div class="ie-section">
        <div class="ie-section-title ie-title-row">
          {t('fields.personalDetails')}
          <Show when={ocrAvailable()}>
            <button
              class="ghost ie-add ie-scan-qr"
              disabled={ocrBusy()}
              onClick={() => void fillFromImage()}
              title={t('fields.fromImageIdentityTooltip')}
            >
              <ImageUp size={13} strokeWidth={1.75} /> {t('fields.fromImage')}
            </button>
          </Show>
        </div>
        <div class="ie-grid-3">
          <div class="field">
            <label>{t('fields.identityTitle')}</label>
            <input value={idTitle()} onInput={(e) => setIdTitle(e.currentTarget.value)} />
          </div>
          <div class="field">
            <label>{t('fields.firstName')}</label>
            <input value={firstName()} onInput={(e) => setFirstName(e.currentTarget.value)} />
          </div>
          <div class="field">
            <label>{t('fields.middleName')}</label>
            <input value={middleName()} onInput={(e) => setMiddleName(e.currentTarget.value)} />
          </div>
        </div>
        <div class="field">
          <label>{t('fields.lastName')}</label>
          <input value={lastName()} onInput={(e) => setLastName(e.currentTarget.value)} />
        </div>
        <div class="ie-grid-2">
          <div class="field">
            <label>{t('common.username')}</label>
            <input value={idUsername()} onInput={(e) => setIdUsername(e.currentTarget.value)} />
          </div>
          <div class="field">
            <label>{t('fields.company')}</label>
            <input value={company()} onInput={(e) => setCompany(e.currentTarget.value)} />
          </div>
        </div>
        <div class="ie-grid-2">
          <div class="field">
            <label>{t('fields.email')}</label>
            <input value={email()} onInput={(e) => setEmail(e.currentTarget.value)} />
          </div>
          <div class="field">
            <label>{t('fields.phone')}</label>
            <input value={phone()} onInput={(e) => setPhone(e.currentTarget.value)} />
          </div>
        </div>
        <div class="ie-grid-3">
          <div class="field">
            <label>{t('fields.ssn')}</label>
            <input value={ssn()} onInput={(e) => setSsn(e.currentTarget.value)} autocomplete="off" />
          </div>
          <div class="field">
            <label>{t('fields.passportNumber')}</label>
            <input
              value={passportNumber()}
              onInput={(e) => setPassportNumber(e.currentTarget.value)}
              autocomplete="off"
            />
          </div>
          <div class="field">
            <label>{t('fields.licenseNumber')}</label>
            <input
              value={licenseNumber()}
              onInput={(e) => setLicenseNumber(e.currentTarget.value)}
              autocomplete="off"
            />
          </div>
        </div>
      </div>
      <div class="ie-section">
        <div class="ie-section-title">{t('fields.address')}</div>
        <div class="field">
          <label>{t('fields.addressLine1')}</label>
          <input value={address1()} onInput={(e) => setAddress1(e.currentTarget.value)} />
        </div>
        <div class="field">
          <label>{t('fields.addressLine2')}</label>
          <input value={address2()} onInput={(e) => setAddress2(e.currentTarget.value)} />
        </div>
        <div class="field">
          <label>{t('fields.addressLine3')}</label>
          <input value={address3()} onInput={(e) => setAddress3(e.currentTarget.value)} />
        </div>
        <div class="ie-grid-2">
          <div class="field">
            <label>{t('fields.city')}</label>
            <input value={city()} onInput={(e) => setCity(e.currentTarget.value)} />
          </div>
          <div class="field">
            <label>{t('fields.stateRegion')}</label>
            <input value={stateRegion()} onInput={(e) => setStateRegion(e.currentTarget.value)} />
          </div>
        </div>
        <div class="ie-grid-2">
          <div class="field">
            <label>{t('fields.postalCode')}</label>
            <input value={postalCode()} onInput={(e) => setPostalCode(e.currentTarget.value)} />
          </div>
          <div class="field">
            <label>{t('fields.country')}</label>
            <input value={country()} onInput={(e) => setCountry(e.currentTarget.value)} />
          </div>
        </div>
      </div>
    </>
  );
}
