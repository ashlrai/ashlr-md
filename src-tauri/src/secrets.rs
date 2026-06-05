//! Secure storage for AI provider API keys.
//!
//! Keys live in the OS-native secret store — macOS Keychain, Windows Credential
//! Manager, or the Linux Secret Service — via the `keyring` crate, instead of
//! plaintext `localStorage` in the webview.  This removes the highest-value
//! secret from any XSS blast radius: a malicious `.md` file that achieved script
//! execution can no longer read the key out of `localStorage`.
//!
//! The frontend addresses each key by a short `account` label (e.g.
//! `"anthropic"`) under a single service name, so additional providers can be
//! added without new commands.

use keyring::{Entry, Error as KeyringError};

/// Service name under which all Ashlr MD secrets are grouped in the keychain.
const SERVICE: &str = "app.mdopener.desktop";

fn entry(account: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, account).map_err(|e| format!("keychain entry error: {e}"))
}

/// Store (or overwrite) the API key for `account` in the OS keychain.
#[tauri::command]
pub fn set_ai_key(account: String, key: String) -> Result<(), String> {
    entry(&account)?
        .set_password(&key)
        .map_err(|e| format!("could not save key to keychain: {e}"))
}

/// Read the API key for `account`.  Returns `None` when no key is stored.
#[tauri::command]
pub fn get_ai_key(account: String) -> Result<Option<String>, String> {
    match entry(&account)?.get_password() {
        Ok(key) => Ok(Some(key)),
        // No stored key, or duplicate entries (e.g. a stale entry left by a
        // reinstall on Linux Secret Service) — treat both as "no usable key".
        Err(KeyringError::NoEntry) | Err(KeyringError::Ambiguous(_)) => Ok(None),
        Err(e) => Err(format!("could not read key from keychain: {e}")),
    }
}

/// Delete the stored API key for `account`.  A missing key is treated as success.
#[tauri::command]
pub fn delete_ai_key(account: String) -> Result<(), String> {
    match entry(&account)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(KeyringError::NoEntry) | Err(KeyringError::Ambiguous(_)) => Ok(()),
        Err(e) => Err(format!("could not delete key from keychain: {e}")),
    }
}
