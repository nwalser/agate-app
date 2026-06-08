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
//! `Cipher`s here. If a pinned-rev bump breaks the conversion or the view shape,
//! this module is the blast radius.

use bitwarden_generators::PasswordGeneratorRequest;
use bitwarden_sync::SyncRequest;
use bitwarden_vault::{generate_totp, Cipher, CipherType, CipherView};
use chrono::Utc;

use crate::dto::{
    CustomField, Folder, ItemDetail, ItemType, LoginDetail, LoginUri, PasswordGenOptions, TotpCode,
    VaultItem,
};
use crate::error::{AgateError, AgateResult, ErrorKind};
use crate::state::{AppState, Session};

fn cipher_type_to_dto(t: CipherType) -> ItemType {
    match t {
        CipherType::Login => ItemType::Login,
        CipherType::SecureNote => ItemType::SecureNote,
        CipherType::Card => ItemType::Card,
        CipherType::Identity => ItemType::Identity,
        CipherType::SshKey => ItemType::SshKey,
    }
}

/// Borrow the unlocked client out of the session, or fail with a typed error.
fn require_client<'a>(session: &'a Session) -> AgateResult<&'a bitwarden_pm::PasswordManagerClient> {
    session.client.as_ref().ok_or_else(AgateError::not_authenticated)
}

/// Sync the vault from the server and cache the encrypted ciphers in memory.
pub async fn sync(state: &AppState, force: bool) -> AgateResult<()> {
    // Run the network sync without holding the session lock across .await on the
    // client we then mutate — clone the client handle (cheap, Arc-backed).
    let client = {
        let session = state.session.lock().await;
        require_client(&session)?.clone()
    };

    let response = client
        .sync()
        .sync(SyncRequest { force, exclude_subdomains: None })
        .await
        .map_err(|e| AgateError::new(ErrorKind::Network, format!("Sync failed: {e}")))?;

    // Convert raw API cipher models → domain ciphers. Undecodable ones are
    // skipped loudly rather than failing the whole sync.
    let mut ciphers: Vec<Cipher> = Vec::new();
    for model in response.ciphers.unwrap_or_default() {
        match Cipher::try_from(model) {
            Ok(c) => ciphers.push(c),
            Err(e) => log::warn!("skipping cipher that failed to decode: {e}"),
        }
    }

    // Folder names need decryption; treat folders as best-effort (non-critical
    // for browsing). On any error, log and continue with no folder names.
    let folders = decrypt_folders(&client, response.folders.unwrap_or_default()).await;

    let mut session = state.session.lock().await;
    session.ciphers = ciphers;
    session.folders = folders;
    Ok(())
}

async fn decrypt_folders(
    client: &bitwarden_pm::PasswordManagerClient,
    models: Vec<bitwarden_api_api::models::FolderResponseModel>,
) -> Vec<Folder> {
    let domain: Vec<bitwarden_vault::Folder> = models
        .into_iter()
        .filter_map(|m| bitwarden_vault::Folder::try_from(m).ok())
        .collect();
    match client.vault().folders().decrypt_list(domain).await {
        Ok(views) => views
            .into_iter()
            .map(|v| Folder { id: v.id.map(|i| i.to_string()), name: v.name })
            .collect(),
        Err(e) => {
            log::warn!("folder decryption failed, hiding folder names: {e}");
            Vec::new()
        }
    }
}

/// Decrypt the cached ciphers into list rows.
pub async fn list_items(state: &AppState) -> AgateResult<Vec<VaultItem>> {
    let (client, ciphers) = {
        let session = state.session.lock().await;
        (require_client(&session)?.clone(), session.ciphers.clone())
    };

    let ciphers_client = client.vault().ciphers();
    let mut items = Vec::with_capacity(ciphers.len());
    for cipher in ciphers {
        let view = ciphers_client
            .decrypt(cipher)
            .await
            .map_err(|e| AgateError::new(ErrorKind::Crypto, format!("decrypt failed: {e}")))?;
        items.push(view_to_list_item(&view));
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
        folder_id: view.folder_id.map(|i| i.to_string()),
        organization_id: view.organization_id.map(|i| i.to_string()),
    }
}

/// Find and decrypt one cipher into full detail.
pub async fn item_detail(state: &AppState, id: &str) -> AgateResult<ItemDetail> {
    let view = decrypt_one(state, id).await?;

    let login = view.login.as_ref().map(|l| LoginDetail {
        username: l.username.clone(),
        password: l.password.clone(),
        uris: l
            .uris
            .as_ref()
            .map(|uris| uris.iter().map(|u| LoginUri { uri: u.uri.clone() }).collect())
            .unwrap_or_default(),
        has_totp: l.totp.is_some(),
    });

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

    Ok(ItemDetail {
        id: view.id.map(|i| i.to_string()).unwrap_or_default(),
        name: view.name.clone(),
        item_type: cipher_type_to_dto(view.r#type),
        favorite: view.favorite,
        notes: view.notes.clone(),
        login,
        fields,
        folder_id: view.folder_id.map(|i| i.to_string()),
        organization_id: view.organization_id.map(|i| i.to_string()),
    })
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

async fn decrypt_one(state: &AppState, id: &str) -> AgateResult<CipherView> {
    let (client, cipher) = {
        let session = state.session.lock().await;
        let client = require_client(&session)?.clone();
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

/// List decrypted folder names from the last sync.
pub async fn list_folders(state: &AppState) -> AgateResult<Vec<Folder>> {
    Ok(state.session.lock().await.folders.clone())
}

/// Generate a password with the given options (no session required).
pub async fn generate_password(state: &AppState, opts: PasswordGenOptions) -> AgateResult<String> {
    if !(opts.uppercase || opts.lowercase || opts.numbers || opts.special) {
        return Err(AgateError::bad_request("Select at least one character set."));
    }
    let length = opts.length.clamp(5, 128);

    let client = {
        let session = state.session.lock().await;
        // The generator doesn't need an unlocked vault, but reuse the session
        // client when present to avoid constructing a throwaway one.
        session.client.clone()
    };
    let client = match client {
        Some(c) => c,
        None => bitwarden_pm::PasswordManagerClient::new(None),
    };

    let request = PasswordGeneratorRequest {
        lowercase: opts.lowercase,
        uppercase: opts.uppercase,
        numbers: opts.numbers,
        special: opts.special,
        length,
        ..Default::default()
    };
    client
        .generator()
        .password(request)
        .await
        .map_err(|e| AgateError::new(ErrorKind::Internal, format!("generate failed: {e}")))
}
