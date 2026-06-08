//! Vault operations: sync, list, item detail, TOTP, password generation.
//!
//! All SDK calls are isolated here. The read path decrypts each cipher to a
//! full `CipherView` (a stable, well-understood SDK type) rather than relying on
//! the more volatile `CipherListView` shape — slightly less efficient, far less
//! likely to break across SDK revs.
//!
//! NOTE (unstable SDK): `sync()` returns the raw `SyncResponseModel`; the SDK
//! does not yet materialize ciphers into a repository on its own (its own `bw`
//! CLI leaves `list` as `todo!()`). We convert the API models to domain
//! `Cipher`s here. Folder *names* are encrypted and their decryption path is in
//! flux upstream, so v0.1 lists items without folder grouping (see `list_folders`).

use bitwarden_generators::{PassphraseGeneratorRequest, PasswordGeneratorRequest};
use bitwarden_pm::PasswordManagerClient;
use bitwarden_sync::SyncRequest;
use bitwarden_vault::{generate_totp, Cipher, CipherRepromptType, CipherType, CipherView};
use chrono::Utc;

use crate::dto::{
    CustomField, Folder, ItemDetail, ItemType, LoginDetail, LoginUri, PasswordGenOptions, TotpCode,
    VaultItem,
};
use crate::error::{AgateError, AgateResult, ErrorKind};
use crate::state::AppState;

fn cipher_type_to_dto(t: CipherType) -> ItemType {
    match t {
        CipherType::Login => ItemType::Login,
        CipherType::SecureNote => ItemType::SecureNote,
        CipherType::Card => ItemType::Card,
        CipherType::Identity => ItemType::Identity,
        CipherType::SshKey => ItemType::SshKey,
        // Newer item types we don't render specially yet.
        CipherType::BankAccount | CipherType::DriversLicense | CipherType::Passport => {
            ItemType::Unknown
        }
    }
}

/// A fresh handle to the unlocked client, or a typed error if locked.
pub(crate) async fn client(state: &AppState) -> AgateResult<PasswordManagerClient> {
    state
        .session
        .lock()
        .await
        .cloned_client()
        .ok_or_else(AgateError::not_authenticated)
}

/// Sync the vault from the server and cache the encrypted ciphers in memory.
pub async fn sync(state: &AppState, force: bool) -> AgateResult<()> {
    let client = client(state).await?;

    let response = client
        .sync()
        .sync(SyncRequest { force, exclude_subdomains: None })
        .await
        .map_err(|e| {
            let mut msg = format!("Sync failed: {e}");
            // Append the (types-only, value-free) response shape captured by the
            // self-hosted proxy, to pinpoint server/SDK schema mismatches.
            if let Some(shape) = crate::proxy::last_sync_shape() {
                let shape = &shape[..shape.len().min(1800)];
                msg.push_str(&format!(" | response shape: {shape}"));
            }
            AgateError::new(ErrorKind::Network, msg)
        })?;

    // Convert raw API cipher models → domain ciphers. Undecodable ones are
    // skipped loudly rather than failing the whole sync.
    let mut ciphers: Vec<Cipher> = Vec::new();
    for model in response.ciphers.unwrap_or_default() {
        match Cipher::try_from(model) {
            Ok(c) => ciphers.push(c),
            Err(e) => log::warn!("skipping cipher that failed to decode: {e}"),
        }
    }

    // Populate the SDK's local cipher repository so repository-backed write ops
    // work (notably `edit`, which reads the original to build password history).
    // Best-effort: if no Cipher repository is registered, skip and log.
    match client.0.platform().state().get::<Cipher>() {
        Ok(repo) => {
            for c in &ciphers {
                if let Some(id) = c.id {
                    if let Err(e) = repo.set(id, c.clone()).await {
                        log::warn!("cipher repository populate failed: {e}");
                    }
                }
            }
        }
        Err(e) => log::warn!("no cipher repository registered; edits may be limited: {e}"),
    }

    let mut session = state.session.lock().await;
    session.ciphers = ciphers;
    // Folder-name decryption is deferred (see module note); browse without it.
    session.folders = Vec::new();
    Ok(())
}

/// Decrypt the cached ciphers into list rows.
///
/// Uses the key store's synchronous `decrypt` in a tight loop rather than the
/// async `CiphersClient::decrypt` per item — the latter does an async
/// feature-flag fetch on every call, which is hundreds of awaits for a large
/// vault. This is the same `CipherView` output without that per-item overhead.
pub async fn list_items(state: &AppState) -> AgateResult<Vec<VaultItem>> {
    let (client, ciphers) = {
        let session = state.session.lock().await;
        let client = session.cloned_client().ok_or_else(AgateError::not_authenticated)?;
        (client, session.ciphers.clone())
    };

    let key_store = client.0.internal.get_key_store();
    let mut items = Vec::with_capacity(ciphers.len());
    for cipher in &ciphers {
        let decrypted: Result<CipherView, _> = key_store.decrypt(cipher);
        match decrypted {
            Ok(view) => items.push(view_to_list_item(&view)),
            // A single undecryptable item shouldn't blank the whole list.
            Err(e) => log::warn!("skipping item that failed to decrypt: {e}"),
        }
    }
    Ok(items)
}

fn view_to_list_item(view: &CipherView) -> VaultItem {
    let (username, has_totp) = match &view.login {
        Some(login) => (login.username.clone(), login.totp.is_some()),
        None => (None, false),
    };
    VaultItem {
        id: view.id.map(|i| i.to_string()).unwrap_or_default(),
        name: view.name.clone(),
        item_type: cipher_type_to_dto(view.r#type),
        username,
        has_totp,
        favorite: view.favorite,
        deleted: view.deleted_date.is_some(),
        folder_id: view.folder_id.map(|i| i.to_string()),
        organization_id: view.organization_id.map(|i| i.to_string()),
    }
}

/// Find and decrypt one cipher into full detail.
pub async fn item_detail(state: &AppState, id: &str) -> AgateResult<ItemDetail> {
    let view = decrypt_one(state, id).await?;
    Ok(view_to_detail(&view))
}

/// Map a decrypted `CipherView` into the frontend `ItemDetail` DTO.
pub fn view_to_detail(view: &CipherView) -> ItemDetail {
    let login = view.login.as_ref().map(|l| LoginDetail {
        username: l.username.clone(),
        password: l.password.clone(),
        totp: l.totp.clone(),
        uris: l
            .uris
            .as_ref()
            .map(|uris| {
                uris.iter()
                    .map(|u| LoginUri { uri: u.uri.clone(), match_type: u.r#match.map(|m| m as u8) })
                    .collect()
            })
            .unwrap_or_default(),
        has_totp: l.totp.as_ref().map(|t| !t.is_empty()).unwrap_or(false),
    });

    // Type-specific sub-views round-tripped through serde so the editor can
    // prefill every field (preventing edit-time data loss). Infallible: on a
    // shape mismatch we fall back to None rather than panic.
    let card = view
        .card
        .as_ref()
        .and_then(|c| serde_json::to_value(c).ok())
        .and_then(|v| serde_json::from_value(v).ok());
    let identity = view
        .identity
        .as_ref()
        .and_then(|i| serde_json::to_value(i).ok())
        .and_then(|v| serde_json::from_value(v).ok());
    let ssh_key = view
        .ssh_key
        .as_ref()
        .and_then(|s| serde_json::to_value(s).ok())
        .and_then(|v| serde_json::from_value(v).ok());

    let fields = view
        .fields
        .as_ref()
        .map(|fields| {
            fields
                .iter()
                .map(|f| CustomField {
                    name: f.name.clone(),
                    value: f.value.clone(),
                    field_type: format!("{:?}", f.r#type).to_lowercase(),
                })
                .collect()
        })
        .unwrap_or_default();

    ItemDetail {
        id: view.id.map(|i| i.to_string()).unwrap_or_default(),
        name: view.name.clone(),
        item_type: cipher_type_to_dto(view.r#type),
        favorite: view.favorite,
        reprompt: matches!(view.reprompt, CipherRepromptType::Password),
        notes: view.notes.clone(),
        login,
        card,
        identity,
        ssh_key,
        fields,
        folder_id: view.folder_id.map(|i| i.to_string()),
        organization_id: view.organization_id.map(|i| i.to_string()),
    }
}

/// Generate the current TOTP code for an item that has one.
pub async fn item_totp(state: &AppState, id: &str) -> AgateResult<TotpCode> {
    let view = decrypt_one(state, id).await?;
    let secret = view
        .login
        .as_ref()
        .and_then(|l| l.totp.clone())
        .ok_or_else(|| AgateError::bad_request("Item has no TOTP secret."))?;

    let now = Utc::now();
    let response = generate_totp(secret, Some(now))
        .map_err(|e| AgateError::new(ErrorKind::Crypto, format!("TOTP failed: {e}")))?;

    let period = response.period;
    let remaining = if period == 0 {
        0
    } else {
        period - (now.timestamp() as u32 % period)
    };
    Ok(TotpCode { code: response.code, period, remaining })
}

pub(crate) async fn decrypt_one(state: &AppState, id: &str) -> AgateResult<CipherView> {
    let (client, cipher) = {
        let session = state.session.lock().await;
        let client = session.cloned_client().ok_or_else(AgateError::not_authenticated)?;
        let cipher = session
            .ciphers
            .iter()
            .find(|c| c.id.map(|i| i.to_string()).as_deref() == Some(id))
            .cloned()
            .ok_or_else(|| AgateError::bad_request("No such item."))?;
        (client, cipher)
    };
    client
        .vault()
        .ciphers()
        .decrypt(cipher)
        .await
        .map_err(|e| AgateError::new(ErrorKind::Crypto, format!("decrypt failed: {e}")))
}

/// List decrypted folders. Reads from the SDK FoldersClient (best-effort).
pub async fn list_folders(state: &AppState) -> AgateResult<Vec<Folder>> {
    let client = client(state).await?;
    match client.vault().folders().list().await {
        Ok(views) => Ok(views
            .into_iter()
            .map(|v| Folder { id: v.id.map(|i| i.to_string()), name: v.name })
            .collect()),
        Err(e) => {
            log::warn!("folder list failed: {e}");
            Ok(Vec::new())
        }
    }
}

/// Generate a password with the given options (no unlocked vault required).
pub async fn generate_password(state: &AppState, opts: PasswordGenOptions) -> AgateResult<String> {
    if !(opts.uppercase || opts.lowercase || opts.numbers || opts.special) {
        return Err(AgateError::bad_request("Select at least one character set."));
    }
    let length = opts.length.clamp(5, 128);

    // Reuse the session client when present; otherwise a throwaway one suffices.
    let client = match state.session.lock().await.cloned_client() {
        Some(c) => c,
        None => PasswordManagerClient::new(None),
    };

    let request = PasswordGeneratorRequest {
        lowercase: opts.lowercase,
        uppercase: opts.uppercase,
        numbers: opts.numbers,
        special: opts.special,
        length,
        avoid_ambiguous: opts.avoid_ambiguous,
        min_number: opts.min_number,
        min_special: opts.min_special,
        ..Default::default()
    };
    client
        .generator()
        .password(request)
        .map_err(|e| AgateError::new(ErrorKind::Internal, format!("generate failed: {e}")))
}

/// Generate a passphrase (EFF wordlist) with the given options.
pub async fn generate_passphrase(
    state: &AppState,
    opts: crate::dto::PassphraseGenOptions,
) -> AgateResult<String> {
    let num_words = opts.num_words.clamp(3, 20);
    let client = match state.session.lock().await.cloned_client() {
        Some(c) => c,
        None => PasswordManagerClient::new(None),
    };
    let request = PassphraseGeneratorRequest {
        num_words,
        word_separator: if opts.word_separator.is_empty() { "-".into() } else { opts.word_separator },
        capitalize: opts.capitalize,
        include_number: opts.include_number,
    };
    client
        .generator()
        .passphrase(request)
        .map_err(|e| AgateError::new(ErrorKind::Internal, format!("generate failed: {e}")))
}
