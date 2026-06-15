// English — the source of truth for every translatable string. Keys are grouped
// into nested namespaces; `src/lib/i18n.ts` flattens them to dotted keys ("a.b.c")
// at load. Every other locale is a `PartialMessages` of this and falls back here
// per missing key, so adding a key to `en` is always safe — untranslated locales
// simply show English until someone fills it in.
//
// Interpolation: `{name}` placeholders are substituted at call time, e.g.
// t('tray.passwordReused', { count: 5 }). Keep placeholder names identical across
// locales (the parity test in locales.test.ts guards key drift, not placeholders).
// There is no plural engine — pick between singular/plural keys at the call site
// (e.g. securitySettings.minuteOne / minutesMany).

export const en = {
  // Generic, reusable terms. Shared across the whole app — components reach for
  // these instead of re-keying "Cancel"/"Copy"/"Delete" per surface.
  common: {
    back: 'Back',
    close: 'Close',
    cancel: 'Cancel',
    delete: 'Delete',
    edit: 'Edit',
    remove: 'Remove',
    copy: 'Copy',
    copied: 'Copied',
    loading: 'Loading…',
    open: 'Open',
    show: 'Show',
    hide: 'Hide',
    name: 'Name',
    username: 'Username',
    password: 'Password',
  },

  settings: {
    title: 'Settings',
  },

  appearance: {
    title: 'Appearance',
    help: 'Choose a light or dark theme, or follow your system setting.',
    language: 'Language',
    languageHelp: 'The language Agate is displayed in.',
  },

  theme: {
    system: 'System',
    light: 'Light',
    dark: 'Dark',
  },

  startup: {
    title: 'Startup',
    help: 'Open Agate automatically when you sign in to your computer. It still starts locked.',
    launch: 'Launch at login',
  },

  // ── Shared vault vocabulary (lib/ + state/) ────────────────────────────────
  itemType: {
    login: 'Login',
    secureNote: 'Secure note',
    card: 'Card',
    identity: 'Identity',
    sshKey: 'SSH key',
    unknown: 'Item',
  },

  column: {
    name: 'Name',
    username: 'Username',
    website: 'Website',
    folder: 'Folder',
    type: 'Type',
    oneTimeCode: 'One-time code',
    password: 'Password',
    passkey: 'Passkey',
  },

  date: {
    justNow: 'just now',
    minutesAgo: '{n}m ago',
    hoursAgo: '{n}h ago',
    daysAgo: '{n}d ago',
    monthsAgo: '{n}mo ago',
    yearsAgo: '{n}y ago',
    inMoments: 'in moments',
    inMinutes: 'in {n}m',
    inHours: 'in {n}h',
    inDays: 'in {n}d',
    inMonths: 'in {n}mo',
    inYears: 'in {n}y',
  },

  // ── Auth / onboarding ──────────────────────────────────────────────────────
  unlock: {
    vaultUnlocked: 'Vault unlocked',
    appPassword: 'App password',
  },

  onboarding: {
    enterEmailAndPassword: 'Enter your email and master password.',
    twoFactorIntro: 'Enter your two-factor code to finish adding this connection.',
    email: 'Email',
    verifyAndAdd: 'Verify & add',
    masterPassword: 'Master password',
    adding: 'Adding…',
    addConnection: 'Add connection',
  },

  reprompt: {
    title: "Verify it's you",
    desc: '“{name}” requires your app password to view.',
    placeholder: 'App password',
    incorrect: 'Incorrect app password.',
    checking: 'Checking…',
    unlock: 'Unlock',
  },

  // ── Settings pages ─────────────────────────────────────────────────────────
  connections: {
    removed: 'Connection removed.',
    badgeAutoUnlock: 'Auto-unlock',
    badgeManual: 'Manual',
    badgeUnlocked: 'Unlocked',
    badgeLocked: 'Locked',
    unlockNow: 'Unlock now',
    editConnection: 'Edit connection',
    removeConnection: 'Remove connection',
    logoutAll: 'Log out of everything',
    provider: 'Provider',
    providerAuthenticator: 'Authenticator app',
    providerEmail: 'Email',
    sendCodeToEmail: 'Send code to email',
    verificationCode: 'Verification code',
    enterMasterPwToApply: 'Enter your master password to apply these changes.',
    twoFactorRequired: 'Two-factor authentication required.',
    updated: 'Connection updated.',
    codeSent: 'Code sent to your email.',
    server: 'Server',
    serverUs: 'Bitwarden — US (bitwarden.com)',
    serverEu: 'Bitwarden — EU (bitwarden.eu)',
    serverSelfHosted: 'Self-hosted / Vaultwarden…',
    serverUrl: 'Server URL',
    storeLogin: 'Store login on this device (auto-unlock)',
    masterPassword: 'Master password',
    masterPasswordOnlyReauth: '(only to re-authenticate)',
    pwRequiredForChange: 'Required for this change',
    pwLeaveBlank: 'Leave blank to keep current',
    saving: 'Saving…',
    verifyAndSave: 'Verify & save',
    saveChanges: 'Save changes',
    enterAccountMasterPw: 'Enter this account’s master password.',
    unlocked: 'Connection unlocked.',
    unlockEmail: 'Unlock {email}',
    unlocking: 'Unlocking…',
    verifyAndUnlock: 'Verify & unlock',
    unlock: 'Unlock',
  },

  updates: {
    never: 'Never',
    unknown: 'Unknown',
    title: 'Updates',
    upToDate: "You're on the latest version.",
    checking: 'Checking…',
    checkForUpdates: 'Check for updates',
    versionAvailable: 'Version {version} is available.',
    installing: 'Installing…',
    installAndRestart: 'Install & restart',
    lastChecked: 'Last checked: {time}',
    checkOnLaunch: 'Check for updates on launch',
    checkOnLaunchDesc: 'Look for a newer release each time Agate starts.',
    autoInstall: 'Download and install automatically',
    autoInstallDesc: 'When a launch check finds an update, install it and restart without asking.',
    versionLabel: 'Version {version}',
    footer: 'Agate · unofficial Bitwarden client · GPL-3.0',
  },

  securitySettings: {
    never: 'Never',
    oneMinute: '1 minute',
    seconds: '{seconds} seconds',
    oneHour: '1 hour',
    minuteOne: '{minutes} minute',
    minutesMany: '{minutes} minutes',
    vaultTimeout: 'Vault timeout',
    vaultTimeoutHelpBefore:
      'Lock every connection automatically after this much inactivity. The stored master passwords stay sealed; unlocking re-opens them.',
    vaultTimeoutHelpAfter: 'keeps the vault unlocked until you lock it yourself.',
    autoLockAriaLabel: 'Auto-lock idle timeout',
    lockWhenMinimized: 'Lock when the popup closes',
    lockWhenMinimizedDesc:
      'Lock immediately whenever the popup hides, regardless of the idle timeout.',
    clipboard: 'Clipboard',
    clipboardHelp: 'How long a copied secret (password, TOTP, …) stays on the clipboard before Agate wipes it.',
    clipboardAriaLabel: 'Clipboard auto-clear delay',
  },

  unlockSettings: {
    biometricGeneric: 'Biometric unlock',
    pwMinLength: 'App password must be at least 8 characters.',
    pwMismatch: 'Passwords do not match.',
    appUnlockUpdated: 'App unlock updated.',
    biometricDisabled: '{name} unlock disabled.',
    biometricEnabled: '{name} unlock enabled.',
    appPassword: 'App password',
    appPasswordHelp:
      'Change the single app password. Enter the new password twice to apply — stored master passwords are re-protected automatically and stay bound to this machine.',
    newAppPassword: 'New app password',
    confirmPassword: 'Confirm password',
    updateAppUnlock: 'Update app unlock',
    biometricHelp: 'Unlock your vault with {name} (face, fingerprint, or PIN) instead of typing a password.',
    biometricUnavailable: '{name} is not available on this device.',
    useBiometric: 'Use {name}',
  },

  detail: {
    restore: 'Restore',
    deletePermanently: 'Delete permanently',
    unfavorite: 'Unfavorite',
    favorite: 'Favorite',
    moveToTrash: 'Move to trash',
    reveal: 'Reveal',
    oneTimeCode: 'One-time code',
    website: 'Website',
    publicKey: 'Public key',
    fingerprint: 'Fingerprint',
    privateKey: 'Private key',
    passkeys: 'Passkeys',
    removePasskey: 'Remove passkey',
    updated: 'Updated {date}',
    copyField: 'Copy {label}',
    cardBrandFallback: 'Card',
    number: 'Number',
    cardholder: 'Cardholder',
    expires: 'Expires',
    cvv: 'CVV',
    fieldFallback: 'Field',
    off: 'Off',
    on: 'On',
    linkedFieldEmpty: 'Linked field (empty)',
  },

  notes: {
    title: 'Notes',
    showRendered: 'Show rendered',
    showRaw: 'Show raw text',
  },

  // Identity detail-pane rows (lib/itemFields.ts).
  identityField: {
    name: 'Name',
    username: 'Username',
    company: 'Company',
    email: 'Email',
    phone: 'Phone',
    ssn: 'SSN',
    passportNumber: 'Passport number',
    licenseNumber: 'License number',
    address: 'Address',
    cityStateZip: 'City / State / ZIP',
    country: 'Country',
  },

  // Linked-custom-field target labels (lib/itemFields.ts).
  linkedField: {
    fallback: 'Linked',
    username: 'Username',
    password: 'Password',
    brand: 'Brand',
    number: 'Number',
    cardholderName: 'Cardholder name',
    securityCode: 'Security code',
    expirationMonth: 'Expiration month',
    expirationYear: 'Expiration year',
    fullName: 'Full name',
    title: 'Title',
    firstName: 'First name',
    middleName: 'Middle name',
    lastName: 'Last name',
    company: 'Company',
    ssn: 'SSN',
    passportNumber: 'Passport number',
    licenseNumber: 'License number',
    email: 'Email',
    phone: 'Phone',
    address1: 'Address 1',
    address2: 'Address 2',
    address3: 'Address 3',
    city: 'City',
    state: 'State',
    postalCode: 'Postal code',
    country: 'Country',
  },

  // ── Tray, command palette, menus, chrome ───────────────────────────────────
  trayOnboard: {
    intro: 'Welcome. Create one app password — it unlocks every vault you connect on this device.',
    appPassword: 'App password',
    confirmPassword: 'Confirm app password',
    create: 'Set app password',
    creating: 'Setting up…',
    hint: 'At least 8 characters. This is not your Bitwarden master password — it only opens Agate on this computer.',
  },

  traySettings: {
    danger: 'Danger zone',
    logoutHelp:
      'Removes every stored credential from this device — the sealed master passwords, the app unlock, and Windows Hello. Your connection list is kept so accounts are easy to re-add.',
    logoutConfirm: "Really log out everywhere? You will need each account's master password to sign in again.",
    logoutConfirmAction: 'Yes, log out',
  },

  trayVaults: {
    title: 'Vaults',
    addVault: 'Add vault',
    empty: 'No vaults configured yet.',
    needsTwoFactor: '2FA needed',
    removeConfirm: 'Remove {email}?',
    storedUnlockIntro: "Unlocks with the stored login — enter this account's two-factor code.",
    useMasterPassword: 'Use master password instead',
    useStoredLogin: 'Use stored login (2FA code)',
    added: 'Vault added.',
    sourceTitle: 'What do you want to add?',
    sourceBitwarden: 'Bitwarden account',
    sourceKeepass: 'KeePass database',
    openExisting: 'Open existing',
    createNew: 'Create new',
    databaseFile: 'Database file',
    newDatabaseFile: 'New database file',
    chooseFile: 'Choose file…',
    chooseLocation: 'Choose location…',
    dbPassword: 'Database password',
    confirmDbPassword: 'Confirm password',
    keyfile: 'Key file',
    keyfileOptional: '(optional)',
    rememberDbPassword: 'Remember database password',
    addKeepass: 'Add database',
    createKeepass: 'Create database',
    creating: 'Creating…',
    createKeepassNote: 'A new, empty KeePass database (KDBX4) will be created.',
    created: 'Vault created.',
    selectDbAndPassword: 'Choose a database file and enter its password.',
    chooseLocationAndPassword: 'Choose where to save the database and set a password.',
    dbPasswordsDontMatch: 'The passwords do not match.',
    enterDbPassword: 'Enter the database password.',
    unlockDb: 'Unlock {name}',
    keepass: 'KeePass',
    clearKeyfile: 'Remove key file',
    // pass + Enpass providers (both read-only in Agate)
    sourcePass: 'Password store (pass)',
    sourceEnpass: 'Enpass vault',
    sourceProton: 'Proton Pass',
    comingSoon: 'Coming soon',
    protonComingSoon: "Proton Pass support is on the way — its secure login flow isn't ready yet.",
    pass: 'pass',
    enpass: 'Enpass',
    proton: 'Proton Pass',
    readOnly: 'Read-only in Agate — you can view and copy, but not edit.',
    passStore: 'Store folder',
    chooseFolder: 'Choose folder…',
    passKeyfile: 'OpenPGP secret key',
    passPassphrase: 'Key passphrase',
    passPassphraseHint: '(blank if the key has none)',
    rememberPassphrase: 'Remember key passphrase',
    addPass: 'Add password store',
    selectStoreAndKey: 'Choose your store folder and exported OpenPGP secret key.',
    enterPassphrase: 'Enter the key passphrase.',
    enpassVault: 'Vault file',
    addEnpass: 'Add Enpass vault',
    selectVaultAndPassword: 'Choose your vault.enpassdb file and enter its password.',
  },

  trayDetail: {
    confirmDelete: 'Delete permanently?',
  },

  tray: {
    lock: 'Lock',
    repromptBlocked: 'Master-password protected — open Agate to copy.',
    copyUsername: 'Copy username',
    copyPassword: 'Copy password',
    copyTotp: 'Copy TOTP code',
    locked: 'Vault is locked',
    searchPlaceholder: 'Search vault…',
    noMatches: 'No matches.',
    appPasswordPlaceholder: 'App password…',
    unlock: 'Unlock',
    unlocking: 'Unlocking…',
    unlockWithHello: 'Unlock with Windows Hello',
    twoFactorPending: '2FA needed for {emails} — open Agate to finish.',
    addLogin: 'Add login',
    newLogin: 'New login',
    editLogin: 'Edit login',
    generatePassword: 'Generate password',
    saveLogin: 'Save login',
    saveChanges: 'Save changes',
    saving: 'Saving…',
    loginSaved: 'Login saved.',
    loginUpdated: 'Login updated.',
    passwordReused: 'This password is already used by {count} of your logins.',
    similarExisting: 'Similar logins already in your vault:',
    noUnlockedAccount: 'Unlock an account to add a login.',
    destinationVault: 'Save to',
    totpKey: 'Authenticator key (TOTP)',
    notes: 'Notes',
    favorite: 'Favorite',
    requireMasterPassword: 'Require master password',
    folder: 'Folder',
    noFolder: 'No folder',
    group: 'Group',
    noGroup: 'No group',
    collection: 'Collection',
    personalVault: 'Personal vault',
    strength: {
      veryWeak: 'Very weak',
      weak: 'Weak',
      fair: 'Fair',
      strong: 'Strong',
      veryStrong: 'Very strong',
    },
  },

  autofill: {
    title: 'Autofill',
    help: 'Let Agate watch for login fields in other apps — webview sign-in popups (Microsoft, OAuth) and native apps — and fill the matching login with no copy-paste.',
    modeLabel: 'Detection',
    mode: {
      off: 'Off',
      hotkey: 'On hotkey',
      watch: 'Always watch',
    },
    offHint: 'Agate never inspects other windows.',
    hotkeyHint: 'Press {hotkey} while a login field is focused to offer a fill.',
    watchHint: 'Offers a fill whenever a login field — username, password, or one-time code — in any app gains focus.',
    unsupported: 'Autofill is only available on Windows for now.',
    securityNote:
      'You always pick the login in the popup before anything is filled, and master-password-protected items are never filled here. Filling into an app running as administrator may be blocked by Windows.',
    fillInto: 'Fill into {target}',
    noneFound: 'No login found for {target}',
    unknownTarget: 'the focused window',
    fill: 'Fill',
    submit: 'Submit after filling',
    submitHint:
      'Press Enter to submit the form after autofill. Off by default — some forms break on an early submit.',
    denylist: 'Never autofill in these apps',
    denylistHint:
      'Agate never offers autofill in apps listed here. Use the process name, e.g. “discord”.',
    denylistAdd: 'Add',
    denylistPlaceholder: 'process name',
    rememberHere: 'Use here',
    rememberHereTooltip: 'Remember this login for {target}',
    remembered: 'Remembered for {target}.',
  },

  generator: {
    password: 'Password',
    passphrase: 'Passphrase',
    username: 'Username',
    title: 'Generator',
    wordsLabel: 'Words: {count}',
    lengthLabel: 'Length: {count}',
    separator: 'Separator',
    capitalize: 'Capitalize',
    includeNumber: 'Include number',
    charsetUpperAscii: 'A-Z',
    charsetLowerAscii: 'a-z',
    charsetNumbersAscii: '0-9',
    charsetSpecial: '!@#',
    avoidAmbiguous: 'Avoid ambiguous',
    regenerate: 'Regenerate',
    emptyUsername: 'Enter a base email or domain.',
    emptyCharset: 'Pick at least one character set.',
    usernameModePlusAddressed: 'Plus-addressed',
    usernameModeCatchAll: 'Catch-all',
    usernameModeRandom: 'Random',
    baseEmail: 'Base email',
    plusAddressedHintBefore: 'Aliases like',
    plusAddressedHintAfter: 'all land in your inbox.',
    catchAllDomain: 'Catch-all domain',
    catchAllHint: 'Needs a domain configured to accept all addresses.',
    randomHint: 'A random standalone username.',
  },

  // Copy feedback (lib/clipboard.ts + components/CopyButton.tsx). Success is shown
  // by animation, not a toast; this is the aria/title for the live countdown a copy
  // button morphs into while the secret is still on the clipboard.
  clipboard: {
    clearsIn: 'Clears in {seconds}s',
  },
};

// Locale type: same nested key structure as English, but every leaf is a plain
// `string` (a translation differs from the English literal). Locale files annotate
// with `: PartialMessages` so TS enforces key/shape parity — typos and wrong
// nesting error at compile time — without demanding the value equal the English.
type Stringify<T> = { [K in keyof T]: T[K] extends string ? string : Stringify<T[K]> };
export type Messages = Stringify<typeof en>;

// Locales may OMIT keys — `t()` falls back to English at runtime — so each locale
// is a deep-partial of Messages: keys it DOES provide are shape-checked, missing
// ones resolve to English.
type DeepPartial<T> = { [K in keyof T]?: T[K] extends string ? T[K] : DeepPartial<T[K]> };
export type PartialMessages = DeepPartial<Messages>;
