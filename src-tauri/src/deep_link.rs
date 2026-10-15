//! Deep-link handler for the `mdopener://` custom URL scheme.
//!
//! Supported URLs:
//!   mdopener://open?path=<percent-encoded absolute path>[&mode=read|edit]
//!   mdopener://export?path=<percent-encoded absolute path>&format=pdf|docx|html
//!
//! The handler is called both on cold-start (app launched by the link) and
//! warm (app already running) — tauri-plugin-deep-link surfaces both via the
//! same `on_open_url` callback registered in `setup`.
//!
//! For `open`:  reuses the existing PendingFiles + `file-opened` event flow so
//!              the frontend needs no changes to handle deep-link opens.
//!
//! For `export`: emits `mcp://export` with `{format, path}` so the frontend
//!               can trigger the export UI/logic. The file is also queued for
//!               opening first, so the app loads it if it is not already open.

use crate::PendingFiles;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt as _;

/// Register the deep-link `on_open_url` handler.  Call this inside `.setup()`.
pub fn setup(app: &AppHandle) {
    register_appimage_scheme(app);

    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            handle_url(&handle, url.as_str());
        }
    });

    // Handle any URLs that arrived before the handler was registered
    // (cold-start on some platforms).
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        for url in urls {
            handle_url(app, url.as_str());
        }
    }
}

/// An AppImage has no installer, so nothing registers `mdopener://` with the
/// desktop. When running as one (the AppImage runtime sets `$APPIMAGE`), write
/// the user-level `x-scheme-handler/mdopener` entry pointing at the AppImage.
/// .deb/.rpm installs register through their packaged desktop file and are
/// left alone; Windows installers (NSIS/MSI) register the scheme themselves.
fn register_appimage_scheme(app: &AppHandle) {
    #[cfg(target_os = "linux")]
    if app.env().appimage.is_some() {
        if let Err(e) = app.deep_link().register_all() {
            eprintln!("[deep_link] AppImage scheme registration failed: {e}");
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = app;
}

/// Parse and dispatch a single `mdopener://` URL.
fn handle_url(app: &AppHandle, url: &str) {
    // Require the right scheme.
    let without_scheme = match url.strip_prefix("mdopener://") {
        Some(s) => s,
        None => return,
    };

    // Split "host/path?query" — we treat the host as the command name.
    let (command, query) = without_scheme
        .split_once('?')
        .map(|(c, q)| (c.trim_end_matches('/'), q))
        .unwrap_or((without_scheme.trim_end_matches('/'), ""));

    match command {
        "open" => handle_open(app, query),
        "export" => handle_export(app, query),
        other => {
            eprintln!("[deep_link] unknown command: {other:?}");
        }
    }
}

/// `mdopener://open?path=<enc>&mode=read|edit`
fn handle_open(app: &AppHandle, query: &str) {
    let params = parse_query(query);

    let raw_path = match params.iter().find(|(k, _)| k == "path") {
        Some((_, v)) => v.clone(),
        None => {
            eprintln!("[deep_link] open: missing `path` parameter");
            return;
        }
    };

    let path = percent_decode(&raw_path);

    // Resolve to absolute so the frontend receives a canonical path.
    let abs = match std::fs::canonicalize(&path) {
        Ok(p) => p.to_string_lossy().into_owned(),
        // File may not exist yet (agent is about to create it); keep as-is.
        Err(_) => path.clone(),
    };

    // Buffer the path — mirrors handle_opened() in file_handler.rs.
    {
        let state = app.state::<PendingFiles>();
        let mut buf = state.0.lock().unwrap();
        buf.push(abs.clone());
    }

    // `file-opened` is the live event the frontend listens for.
    let _ = app.emit("file-opened", vec![abs]);
}

/// `mdopener://export?path=<enc>&format=pdf|docx|html`
///
/// Queues the file to open (same as `handle_open`) and then emits
/// `mcp://export` so the frontend can trigger the export flow.
fn handle_export(app: &AppHandle, query: &str) {
    let params = parse_query(query);

    let raw_path = match params.iter().find(|(k, _)| k == "path") {
        Some((_, v)) => v.clone(),
        None => {
            eprintln!("[deep_link] export: missing `path` parameter");
            return;
        }
    };

    let format = params
        .iter()
        .find(|(k, _)| k == "format")
        .map(|(_, v)| v.as_str())
        .unwrap_or("pdf")
        .to_string();

    let path = percent_decode(&raw_path);
    let abs = std::fs::canonicalize(&path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or(path);

    // Open the file first.
    handle_open(app, &format!("path={}", urlencoding::encode(&abs)));

    // Signal the frontend to start the export.
    let _ = app.emit(
        "mcp://export",
        serde_json::json!({ "format": format, "outputPath": null }),
    );
}

// ── Tiny query-string helpers ─────────────────────────────────────────────────

/// Parse `key=value&key=value` into a Vec of owned pairs (no external deps).
fn parse_query(query: &str) -> Vec<(String, String)> {
    query
        .split('&')
        .filter(|s| !s.is_empty())
        .filter_map(|pair| {
            pair.split_once('=')
                .map(|(k, v)| (k.to_string(), v.to_string()))
        })
        .collect()
}

/// Decode percent-encoded sequences and replace `+` with space.
fn percent_decode(s: &str) -> String {
    urlencoding::decode(s)
        .map(|c| c.into_owned())
        .unwrap_or_else(|_| s.replace('+', " "))
}
