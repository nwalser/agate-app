//! Connection management commands (add / update / unlock / remove / lock / logout).

use zeroize::Zeroizing;

use super::State;
use crate::connections;
use crate::dto::{ConnectionSummary, LoginResult, ServerConfig, TwoFactorInput};
use crate::error::AgateResult;

#[tauri::command]
pub async fn list_connections(state: State<'_>) -> AgateResult<Vec<ConnectionSummary>> {
    connections::list_connections(&state).await
}

#[tauri::command]
pub async fn add_connection(
    app: tauri::AppHandle,
    state: State<'_>,
    server: ServerConfig,
    email: String,
    password: String,
    store_credentials: bool,
    two_factor: Option<TwoFactorInput>,
) -> AgateResult<LoginResult> {
    let res = connections::add_connection(
        &state,
        server,
        email,
        Zeroizing::new(password),
        store_credentials,
        two_factor,
    )
    .await;
    if res.is_ok() {
        super::emit_session_changed(&app);
    }
    res
}

#[tauri::command]
pub async fn update_connection(
    app: tauri::AppHandle,
    state: State<'_>,
    email: String,
    server: ServerConfig,
    store_credentials: bool,
    password: Option<String>,
    two_factor: Option<TwoFactorInput>,
) -> AgateResult<LoginResult> {
    let res = connections::update_connection(
        &state,
        email,
        server,
        store_credentials,
        password.map(Zeroizing::new),
        two_factor,
    )
    .await;
    if res.is_ok() {
        super::emit_session_changed(&app);
    }
    res
}

#[tauri::command]
pub async fn unlock_connection(
    app: tauri::AppHandle,
    state: State<'_>,
    email: String,
    password: String,
    two_factor: Option<TwoFactorInput>,
) -> AgateResult<LoginResult> {
    let res =
        connections::unlock_connection(&state, email, Zeroizing::new(password), two_factor).await;
    if res.is_ok() {
        super::emit_session_changed(&app);
    }
    res
}

/// Native picker for a .kdbx database file; `None` when cancelled. The picker
/// blocks its own thread — keep it off the async runtime's workers.
#[tauri::command]
pub async fn pick_keepass_database(app: tauri::AppHandle) -> AgateResult<Option<String>> {
    pick_file(app, Some(("KeePass database", &["kdbx"]))).await
}

/// Native picker for a key file (any extension); `None` when cancelled.
#[tauri::command]
pub async fn pick_keepass_keyfile(app: tauri::AppHandle) -> AgateResult<Option<String>> {
    pick_file(app, None).await
}

async fn pick_file(
    app: tauri::AppHandle,
    filter: Option<(&'static str, &'static [&'static str])>,
) -> AgateResult<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    tokio::task::spawn_blocking(move || {
        let mut dialog = app.dialog().file();
        if let Some((name, exts)) = filter {
            dialog = dialog.add_filter(name, exts);
        }
        dialog
            .blocking_pick_file()
            .and_then(|f| f.into_path().ok())
            .map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .map_err(|_| crate::error::AgateError::internal("file picker was interrupted"))
}

async fn pick_folder(app: tauri::AppHandle) -> AgateResult<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .blocking_pick_folder()
            .and_then(|f| f.into_path().ok())
            .map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .map_err(|_| crate::error::AgateError::internal("folder picker was interrupted"))
}

/// Native picker for a `pass` store root directory; `None` when cancelled.
#[tauri::command]
pub async fn pick_pass_store(app: tauri::AppHandle) -> AgateResult<Option<String>> {
    pick_folder(app).await
}

/// Native picker for an exported OpenPGP secret-key file (any extension);
/// `None` when cancelled.
#[tauri::command]
pub async fn pick_pass_keyfile(app: tauri::AppHandle) -> AgateResult<Option<String>> {
    pick_file(app, None).await
}

#[tauri::command]
pub async fn add_pass_connection(
    app: tauri::AppHandle,
    state: State<'_>,
    store_root: String,
    key_file: String,
    passphrase: String,
    store_credentials: bool,
) -> AgateResult<()> {
    let res = connections::add_pass_connection(
        &state,
        store_root,
        key_file,
        Zeroizing::new(passphrase),
        store_credentials,
    )
    .await;
    if res.is_ok() {
        super::emit_session_changed(&app);
    }
    res
}

#[tauri::command]
pub async fn unlock_pass_connection(
    app: tauri::AppHandle,
    state: State<'_>,
    store_root: String,
    passphrase: String,
) -> AgateResult<()> {
    let res =
        connections::unlock_pass_connection(&state, store_root, Zeroizing::new(passphrase)).await;
    if res.is_ok() {
        super::emit_session_changed(&app);
    }
    res
}

/// Native picker for an Enpass `vault.enpassdb` file; `None` when cancelled.
#[tauri::command]
pub async fn pick_enpass_vault(app: tauri::AppHandle) -> AgateResult<Option<String>> {
    pick_file(app, Some(("Enpass vault", &["enpassdb"]))).await
}

#[tauri::command]
pub async fn add_enpass_connection(
    app: tauri::AppHandle,
    state: State<'_>,
    path: String,
    password: String,
    keyfile: Option<String>,
    store_credentials: bool,
) -> AgateResult<()> {
    let res = connections::add_enpass_connection(
        &state,
        path,
        Zeroizing::new(password),
        keyfile,
        store_credentials,
    )
    .await;
    if res.is_ok() {
        super::emit_session_changed(&app);
    }
    res
}

#[tauri::command]
pub async fn unlock_enpass_connection(
    app: tauri::AppHandle,
    state: State<'_>,
    path: String,
    password: String,
) -> AgateResult<()> {
    let res =
        connections::unlock_enpass_connection(&state, path, Zeroizing::new(password)).await;
    if res.is_ok() {
        super::emit_session_changed(&app);
    }
    res
}

#[tauri::command]
pub async fn add_keepass_connection(
    app: tauri::AppHandle,
    state: State<'_>,
    path: String,
    password: String,
    keyfile: Option<String>,
    store_credentials: bool,
) -> AgateResult<()> {
    let res = connections::add_keepass_connection(
        &state,
        path,
        Zeroizing::new(password),
        keyfile,
        store_credentials,
    )
    .await;
    if res.is_ok() {
        super::emit_session_changed(&app);
    }
    res
}

#[tauri::command]
pub async fn unlock_keepass_connection(
    app: tauri::AppHandle,
    state: State<'_>,
    path: String,
    password: String,
) -> AgateResult<()> {
    let res =
        connections::unlock_keepass_connection(&state, path, Zeroizing::new(password)).await;
    if res.is_ok() {
        super::emit_session_changed(&app);
    }
    res
}

/// Native "save as" picker for the path of a NEW `.kdbx` database; `None` when
/// cancelled. Defaults the file name to `vault.kdbx`. The picker blocks its own
/// thread — keep it off the async runtime's workers.
#[tauri::command]
pub async fn pick_keepass_new_database(app: tauri::AppHandle) -> AgateResult<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("KeePass database", &["kdbx"])
            .set_file_name("vault.kdbx")
            .blocking_save_file()
            .and_then(|f| f.into_path().ok())
            .map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .map_err(|_| crate::error::AgateError::internal("file picker was interrupted"))
}

#[tauri::command]
pub async fn create_keepass_connection(
    app: tauri::AppHandle,
    state: State<'_>,
    path: String,
    password: String,
    keyfile: Option<String>,
    store_credentials: bool,
) -> AgateResult<()> {
    let res = connections::create_keepass_connection(
        &state,
        path,
        Zeroizing::new(password),
        keyfile,
        store_credentials,
    )
    .await;
    if res.is_ok() {
        super::emit_session_changed(&app);
    }
    res
}

#[tauri::command]
pub async fn send_email_code(
    state: State<'_>,
    server: ServerConfig,
    email: String,
    password: String,
) -> AgateResult<()> {
    connections::send_add_email_code(&state, server, email, Zeroizing::new(password)).await
}

#[tauri::command]
pub async fn remove_connection(
    app: tauri::AppHandle,
    state: State<'_>,
    email: String,
) -> AgateResult<()> {
    let res = connections::remove_connection(&state, email).await;
    if res.is_ok() {
        super::emit_session_changed(&app);
    }
    res
}

#[tauri::command]
pub async fn set_active_connection(state: State<'_>, email: String) -> AgateResult<()> {
    connections::set_active(&state, email).await
}

#[tauri::command]
pub async fn lock(app: tauri::AppHandle, state: State<'_>) -> AgateResult<()> {
    let res = connections::lock(&state).await;
    if res.is_ok() {
        super::emit_session_changed(&app);
    }
    res
}

#[tauri::command]
pub async fn logout(app: tauri::AppHandle, state: State<'_>) -> AgateResult<()> {
    let res = connections::logout(&state).await;
    if res.is_ok() {
        super::emit_session_changed(&app);
    }
    res
}
