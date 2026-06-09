// Identity-type fields: personal details + address blocks. Owns its own signals
// and exposes its IdentityInput builder to the orchestrator via `onReady`.
import { createSignal } from 'solid-js';
import type { IdentityInput, ItemDetail } from '../../lib/types.ts';
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

  return (
    <>
      <div class="ie-section">
        <div class="ie-section-title">Personal details</div>
        <div class="ie-grid-3">
          <div class="field">
            <label>Title</label>
            <input value={idTitle()} onInput={(e) => setIdTitle(e.currentTarget.value)} />
          </div>
          <div class="field">
            <label>First name</label>
            <input value={firstName()} onInput={(e) => setFirstName(e.currentTarget.value)} />
          </div>
          <div class="field">
            <label>Middle name</label>
            <input value={middleName()} onInput={(e) => setMiddleName(e.currentTarget.value)} />
          </div>
        </div>
        <div class="field">
          <label>Last name</label>
          <input value={lastName()} onInput={(e) => setLastName(e.currentTarget.value)} />
        </div>
        <div class="ie-grid-2">
          <div class="field">
            <label>Username</label>
            <input value={idUsername()} onInput={(e) => setIdUsername(e.currentTarget.value)} />
          </div>
          <div class="field">
            <label>Company</label>
            <input value={company()} onInput={(e) => setCompany(e.currentTarget.value)} />
          </div>
        </div>
        <div class="ie-grid-2">
          <div class="field">
            <label>Email</label>
            <input value={email()} onInput={(e) => setEmail(e.currentTarget.value)} />
          </div>
          <div class="field">
            <label>Phone</label>
            <input value={phone()} onInput={(e) => setPhone(e.currentTarget.value)} />
          </div>
        </div>
        <div class="ie-grid-3">
          <div class="field">
            <label>SSN</label>
            <input value={ssn()} onInput={(e) => setSsn(e.currentTarget.value)} autocomplete="off" />
          </div>
          <div class="field">
            <label>Passport no.</label>
            <input
              value={passportNumber()}
              onInput={(e) => setPassportNumber(e.currentTarget.value)}
              autocomplete="off"
            />
          </div>
          <div class="field">
            <label>License no.</label>
            <input
              value={licenseNumber()}
              onInput={(e) => setLicenseNumber(e.currentTarget.value)}
              autocomplete="off"
            />
          </div>
        </div>
      </div>
      <div class="ie-section">
        <div class="ie-section-title">Address</div>
        <div class="field">
          <label>Address line 1</label>
          <input value={address1()} onInput={(e) => setAddress1(e.currentTarget.value)} />
        </div>
        <div class="field">
          <label>Address line 2</label>
          <input value={address2()} onInput={(e) => setAddress2(e.currentTarget.value)} />
        </div>
        <div class="field">
          <label>Address line 3</label>
          <input value={address3()} onInput={(e) => setAddress3(e.currentTarget.value)} />
        </div>
        <div class="ie-grid-2">
          <div class="field">
            <label>City</label>
            <input value={city()} onInput={(e) => setCity(e.currentTarget.value)} />
          </div>
          <div class="field">
            <label>State / region</label>
            <input value={stateRegion()} onInput={(e) => setStateRegion(e.currentTarget.value)} />
          </div>
        </div>
        <div class="ie-grid-2">
          <div class="field">
            <label>Postal code</label>
            <input value={postalCode()} onInput={(e) => setPostalCode(e.currentTarget.value)} />
          </div>
          <div class="field">
            <label>Country</label>
            <input value={country()} onInput={(e) => setCountry(e.currentTarget.value)} />
          </div>
        </div>
      </div>
    </>
  );
}
