//! Vault import. Parses a Bitwarden-compatible CSV into create-ready `ItemInput`s
//! (the same shape the editor produces), which the command then writes through the
//! normal `mutate::save_item` path. CSV is the portable interchange format
//! Bitwarden, LastPass, and others export; logins import in full, and any other
//! row type degrades to a secure note (name + notes) so nothing is silently lost.
//!
//! Parsing only — no SDK calls, no I/O. The command owns the file read + writes.

use crate::dto::{ItemInput, ItemType, LoginInput, UriInput};
use crate::error::{AgateError, AgateResult};

fn non_empty(s: &str) -> Option<String> {
    let t = s.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

/// Parse Bitwarden-style CSV (`folder,favorite,type,name,notes,login_uri,
/// login_username,login_password,login_totp`) into `ItemInput`s. Header lookup is
/// case-insensitive and tolerant of extra/missing columns.
pub fn parse_csv(content: &str) -> AgateResult<Vec<ItemInput>> {
    let mut reader = csv::ReaderBuilder::new()
        .flexible(true)
        .from_reader(content.as_bytes());

    let headers = reader
        .headers()
        .map_err(|e| AgateError::bad_request(format!("Could not read CSV header: {e}")))?
        .clone();
    let col = |name: &str| headers.iter().position(|h| h.trim().eq_ignore_ascii_case(name));

    let c_type = col("type");
    let c_name = col("name");
    let c_notes = col("notes");
    let c_fav = col("favorite");
    let c_uri = col("login_uri");
    let c_user = col("login_username");
    let c_pass = col("login_password");
    let c_totp = col("login_totp");

    if c_name.is_none() {
        return Err(AgateError::bad_request("CSV is missing a `name` column."));
    }

    let mut items = Vec::new();
    for record in reader.records() {
        let record =
            record.map_err(|e| AgateError::bad_request(format!("Malformed CSV row: {e}")))?;
        let get = |i: Option<usize>| i.and_then(|i| record.get(i)).and_then(non_empty);

        let Some(name) = get(c_name) else { continue };
        let type_str = get(c_type).unwrap_or_else(|| "login".to_string()).to_lowercase();
        let is_login = type_str == "login" || type_str.is_empty();

        let favorite = get(c_fav)
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);

        // Logins import in full; every other type lands as a secure note so its
        // name + notes survive (card/identity detail columns aren't in this CSV).
        let (item_type, login) = if is_login {
            let uris = get(c_uri)
                .map(|u| vec![UriInput { uri: Some(u), match_type: None }])
                .unwrap_or_default();
            (
                ItemType::Login,
                Some(LoginInput {
                    username: get(c_user),
                    password: get(c_pass),
                    totp: get(c_totp),
                    uris,
                    autofill_on_page_load: None,
                }),
            )
        } else {
            (ItemType::SecureNote, None)
        };

        items.push(ItemInput {
            id: None,
            item_type,
            name,
            folder_id: None,
            organization_id: None,
            favorite,
            reprompt: false,
            notes: get(c_notes),
            login,
            card: None,
            identity: None,
            ssh_key: None,
            fields: Vec::new(),
        });
    }

    Ok(items)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_login_rows() {
        let csv = "folder,favorite,type,name,notes,login_uri,login_username,login_password,login_totp\n\
                   ,1,login,GitHub,my note,https://github.com,me@x.com,hunter2,\n";
        let items = parse_csv(csv).unwrap();
        assert_eq!(items.len(), 1);
        let it = &items[0];
        assert_eq!(it.name, "GitHub");
        assert!(it.favorite);
        let login = it.login.as_ref().unwrap();
        assert_eq!(login.username.as_deref(), Some("me@x.com"));
        assert_eq!(login.password.as_deref(), Some("hunter2"));
        assert_eq!(login.uris.first().and_then(|u| u.uri.as_deref()), Some("https://github.com"));
    }

    #[test]
    fn non_login_rows_become_secure_notes() {
        let csv = "type,name,notes\nnote,Recovery codes,\"line1\nline2\"\n";
        let items = parse_csv(csv).unwrap();
        assert_eq!(items.len(), 1);
        assert!(matches!(items[0].item_type, ItemType::SecureNote));
        assert_eq!(items[0].notes.as_deref(), Some("line1\nline2"));
        assert!(items[0].login.is_none());
    }

    #[test]
    fn rows_without_a_name_are_skipped() {
        let csv = "type,name,login_username\nlogin,,nobody\n";
        assert_eq!(parse_csv(csv).unwrap().len(), 0);
    }

    #[test]
    fn missing_name_column_errors() {
        assert!(parse_csv("type,notes\nlogin,x\n").is_err());
    }
}
