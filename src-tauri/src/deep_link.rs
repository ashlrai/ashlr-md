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

/// The file a `mdopener://open` or `mdopener://export` link may open: its
/// percent-decoded `path`, resolved, when that is an existing Markdown
/// document that is not a dotfile (the rule `/open` applies to agents,
/// [`crate::ipc::checked_agent_path`]). Any web page or program can launch a
/// `mdopener://` link, and the scheme used to open whatever it named
/// (`~/.ssh/id_rsa`, `~/.bashrc`): the window then showed it, `/content`
/// handed it to agents, and a save wrote over it. Errors say why.
fn link_target(query: &str) -> Result<String, String> {
    let params = parse_query(query);
    let raw_path = params
        .iter()
        .find(|(k, _)| k == "path")
        .map(|(_, v)| v.as_str())
        .ok_or("missing `path` parameter")?;
    crate::ipc::checked_agent_path(&percent_decode(raw_path))
}

/// `mdopener://open?path=<enc>&mode=read|edit`
fn handle_open(app: &AppHandle, query: &str) {
    if let Ok(abs) = target_or_log("open", query) {
        open_path(app, abs);
    }
}

/// [`link_target`], logging a refusal.
fn target_or_log(command: &str, query: &str) -> Result<String, ()> {
    link_target(query).map_err(|e| eprintln!("[deep_link] {command}: {e}"))
}

/// Queue `abs` for the window and tell it to open it.
fn open_path(app: &AppHandle, abs: String) {
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
    let Ok(abs) = target_or_log("export", query) else {
        return;
    };
    let params = parse_query(query);
    let format = params
        .iter()
        .find(|(k, _)| k == "format")
        .map(|(_, v)| v.as_str())
        .unwrap_or("pdf")
        .to_string();

    // Open the file first.
    open_path(app, abs);

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

#[cfg(test)]
mod tests {
    use super::link_target;

    /// A scratch directory removed on drop.
    struct Scratch(std::path::PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn query(p: &std::path::Path) -> String {
        format!("path={}", urlencoding::encode(&p.to_string_lossy()))
    }

    /// Any page or program can launch a `mdopener://` link, and it used to
    /// open whatever path it named, for agents to read through `/content`.
    #[test]
    fn links_open_only_markdown_documents() {
        let d = Scratch(std::env::temp_dir().join(format!("deep-link-{}", std::process::id())));
        std::fs::create_dir_all(&d.0).unwrap();
        let md = d.0.join("notes.md");
        std::fs::write(&md, "# hi").unwrap();
        let canon = std::fs::canonicalize(&md).unwrap();
        assert_eq!(link_target(&query(&md)).unwrap(), canon.to_string_lossy());
        // Encoded twice, the path is not decoded twice.
        let twice = format!("path={}", urlencoding::encode(&query(&md)[5..]));
        assert!(link_target(&twice).is_err());

        let key = d.0.join("id_rsa");
        std::fs::write(&key, "PRIVATE KEY").unwrap();
        let env = d.0.join(".env.md");
        std::fs::write(&env, "TOKEN=1").unwrap();
        let mut refused = vec![
            key.clone(),
            env,
            d.0.join("missing.md"),
            d.0.join("..").join("x.txt"),
        ];
        #[cfg(unix)]
        {
            let link = d.0.join("link.md");
            std::os::unix::fs::symlink(&key, &link).unwrap();
            refused.push(link);
        }
        for p in refused {
            assert!(link_target(&query(&p)).is_err(), "{p:?}");
        }
        assert!(link_target("mode=read").is_err());
    }
}
