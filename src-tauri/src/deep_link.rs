//! Deep-link handler for the `mdopener://` custom URL scheme.
//!
//! Supported URLs:
//!   mdopener://open?path=<percent-encoded absolute path>[&mode=read|edit]
//!   mdopener://export?path=<percent-encoded absolute path>[&format=pdf|docx|html|epub][&mode=read]
//!
//! Other parameters are ignored by both, and the first of a repeated one
//! counts.
//!
//! The handler is called both on cold-start (app launched by the link) and
//! warm (app already running) — tauri-plugin-deep-link surfaces both via the
//! same `on_open_url` callback registered in `setup`.
//!
//! For `open`:  reuses the existing PendingFiles + `file-opened` event flow
//!              (PendingFiles only until the window listens for the event).
//!              A `mode` is kept in [`LinkViewModes`] until the window has
//!              opened the file and takes it ([`take_link_view_mode`]), so it
//!              applies on a cold start too.
//!
//! For `export`: queues the file for opening (as `open` does) and keeps the
//!               format in [`LinkExports`] until the window has opened the
//!               file and takes it ([`take_link_export`]), then opens the
//!               export dialog with that format selected. `format` defaults
//!               to `pdf`; any other value than the four is refused. The file
//!               is switched to Read view, which exporting needs, so `mode`
//!               may only be `read`.

use crate::PendingFiles;
use std::collections::HashMap;
use std::sync::Mutex;
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

/// The view each `mdopener://open` link asked for, by the path it opened,
/// until the window opens that path and takes it. The window may not be
/// listening yet (a cold start), so the mode waits here like the path waits
/// in [`PendingFiles`].
#[derive(Default)]
pub struct LinkViewModes(pub LinkRequests);

/// The export format each `mdopener://export` link asked for, by the path it
/// opened, until the window opens that path and takes it. The link used to
/// emit `mcp://export` right after the open event: on a cold start nothing
/// was listening yet, so the request was lost, and on a warm start it could
/// open the dialog before the file had loaded (or for the document that was
/// open before it).
#[derive(Default)]
pub struct LinkExports(pub LinkRequests);

/// One value a link asked for per path, waiting for the window to take it.
#[derive(Default)]
pub struct LinkRequests(Mutex<HashMap<String, &'static str>>);

impl LinkRequests {
    /// Keep `value` for `path`, or with `None` drop what an earlier link left.
    fn set(&self, path: &str, value: Option<&'static str>) {
        let mut map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        match value {
            Some(v) => map.insert(path.to_string(), v),
            None => map.remove(path),
        };
    }

    /// The value kept for `path`, removed so it applies once.
    fn take(&self, path: &str) -> Option<&'static str> {
        let mut map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        map.remove(path)
    }
}

/// The `mode` of an `open` link: `None` without one, else `read` or `edit`.
/// Any other value refuses the link, as `/open` refuses it for agents: the
/// window would ignore it, and the link used to open the file in whatever
/// view it was, `mode=edit` included (the mode was never read).
fn link_mode(query: &str) -> Result<Option<&'static str>, String> {
    let params = parse_query(query);
    let Some((_, raw)) = params.iter().find(|(k, _)| k == "mode") else {
        return Ok(None);
    };
    match percent_decode(raw).as_str() {
        "read" => Ok(Some("read")),
        "edit" => Ok(Some("edit")),
        other => Err(format!(
            "unknown mode {other:?}: use `read` or `edit`, or leave `mode` out"
        )),
    }
}

/// `mdopener://open?path=<enc>&mode=read|edit`
fn handle_open(app: &AppHandle, query: &str) {
    let Ok(abs) = target_or_log("open", query) else {
        return;
    };
    let mode = match link_mode(query) {
        Ok(m) => m,
        Err(e) => return eprintln!("[deep_link] open: {e}"),
    };
    // A link without `mode` keeps the view, even after an earlier link for
    // the same file asked for one.
    app.state::<LinkViewModes>().0.set(&abs, mode);
    open_path(app, abs);
}

/// The view an `mdopener://open` link asked for `path` (`"read"` or
/// `"edit"`), removed so it applies once, or `None`. The window calls this
/// after opening a file from a link.
#[tauri::command]
pub fn take_link_view_mode(
    path: String,
    state: tauri::State<LinkViewModes>,
) -> Option<&'static str> {
    state.0.take(&path)
}

/// The export format an `mdopener://export` link asked for `path`, removed
/// so it applies once, or `None`. The window calls this after opening a file
/// from a link and opens the export dialog with that format.
#[tauri::command]
pub fn take_link_export(path: String, state: tauri::State<LinkExports>) -> Option<&'static str> {
    state.0.take(&path)
}

/// [`link_target`], logging a refusal.
fn target_or_log(command: &str, query: &str) -> Result<String, ()> {
    link_target(query).map_err(|e| eprintln!("[deep_link] {command}: {e}"))
}

/// Queue `abs` for the window and tell it to open it.
fn open_path(app: &AppHandle, abs: String) {
    // Buffer the path for a window not yet listening for `file-opened` (a
    // cold start), as handle_opened() in file_handler.rs does.
    app.state::<PendingFiles>().queue([abs.clone()]);

    // `file-opened` is the live event the frontend listens for.
    let _ = app.emit("file-opened", vec![abs]);
}

/// The formats an export link may ask for, as the app's `/export` takes them.
const LINK_EXPORT_FORMATS: &[&str] = &["pdf", "docx", "html", "epub"];

/// The `format` of an `export` link, `pdf` when it has none. Any other value
/// refuses the link: it used to be passed on as given, so `format=PDF` or
/// `format=md` opened the export dialog with no format selected and no word
/// of why, while `/export` refuses such a format for agents.
fn link_format(query: &str) -> Result<&'static str, String> {
    let params = parse_query(query);
    let Some((_, raw)) = params.iter().find(|(k, _)| k == "format") else {
        return Ok("pdf");
    };
    let format = percent_decode(raw);
    LINK_EXPORT_FORMATS
        .iter()
        .find(|f| **f == format)
        .copied()
        .ok_or_else(|| {
            format!("unknown format {format:?}: use pdf, docx, html or epub, or leave `format` out for pdf")
        })
}

/// The view an `export` link opens its file in: always `read`, which
/// exporting needs (the dialog's exports fail in Edit view). `mode=read` is
/// accepted, as for `open`; `mode=edit` and any other value refuse the link
/// with a logged reason, as `open` refuses an unknown mode. The mode used to
/// be ignored, so an export link opened the file in whatever view it was and
/// the export failed from Edit view.
fn link_export_mode(query: &str) -> Result<&'static str, String> {
    match link_mode(query)? {
        None | Some("read") => Ok("read"),
        Some(_) => Err(
            "mode \"edit\" cannot export: exporting needs Read view, so use `read` or leave `mode` out"
                .to_string(),
        ),
    }
}

/// `mdopener://export?path=<enc>[&format=pdf|docx|html|epub][&mode=read]`
///
/// Queues the file to open (same as `handle_open`) with its format kept in
/// [`LinkExports`], so the window opens the export dialog once the file has
/// loaded, also when the link starts the app.
fn handle_export(app: &AppHandle, query: &str) {
    let Ok(abs) = target_or_log("export", query) else {
        return;
    };
    let format = match link_format(query) {
        Ok(f) => f,
        Err(e) => return eprintln!("[deep_link] export: {e}"),
    };
    let mode = match link_export_mode(query) {
        Ok(m) => m,
        Err(e) => return eprintln!("[deep_link] export: {e}"),
    };

    app.state::<LinkViewModes>().0.set(&abs, Some(mode));
    app.state::<LinkExports>().0.set(&abs, Some(format));
    open_path(app, abs);
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
    use super::{link_export_mode, link_format, link_mode, link_target, LinkRequests};

    /// An export link ignored `mode`, so it exported from whatever view the
    /// file was in, and Edit view cannot export. Other parameters are
    /// ignored, as `open` links ignore them.
    #[test]
    fn export_links_open_in_read_view() {
        assert_eq!(link_export_mode("path=%2Fa.md"), Ok("read"));
        assert_eq!(link_export_mode("path=%2Fa.md&mode=read"), Ok("read"));
        let e = link_export_mode("path=%2Fa.md&mode=edit").unwrap_err();
        assert!(e.contains("exporting needs Read view"), "{e}");
        let e = link_export_mode("mode=Edit").unwrap_err();
        assert!(e.contains("use `read` or `edit`"), "{e}");
        // Unknown parameters are ignored by both kinds of link.
        let q = "path=%2Fa.md&foo=1&format=docx&bare";
        assert_eq!(link_mode(q), Ok(None));
        assert_eq!(link_export_mode(q), Ok("read"));
        assert_eq!(link_format(q), Ok("docx"));
    }

    /// An export link's request used to be an event sent with the open, lost
    /// on a cold start; it now waits per path until the window takes it, once.
    #[test]
    fn link_requests_wait_per_path_and_apply_once() {
        let r = LinkRequests::default();
        r.set("/a.md", Some("docx"));
        r.set("/b.md", Some("pdf"));
        assert_eq!(r.take("/c.md"), None);
        assert_eq!(r.take("/a.md"), Some("docx"));
        assert_eq!(r.take("/a.md"), None);
        // A later link for the same file replaces or clears the request.
        r.set("/b.md", Some("epub"));
        r.set("/a.md", Some("html"));
        r.set("/a.md", None);
        assert_eq!(r.take("/a.md"), None);
        assert_eq!(r.take("/b.md"), Some("epub"));
    }

    /// An export link's `format` was passed on as given, so a misspelt one
    /// opened the dialog with nothing selected and no word of why.
    #[test]
    fn export_links_take_only_known_formats() {
        assert_eq!(link_format("path=%2Fa.md"), Ok("pdf"));
        for f in ["pdf", "docx", "html", "epub"] {
            assert_eq!(link_format(&format!("format={f}&path=x")), Ok(f));
        }
        for bad in ["format=PDF", "format=md", "format=", "format=pdf%20"] {
            let e = link_format(bad).unwrap_err();
            assert!(e.contains("use pdf, docx, html or epub"), "{bad}: {e}");
        }
    }

    /// `mode` was documented (`&mode=edit`) but never read, so a link (and
    /// `mdopen --edit` with the app closed) opened in whatever view it was.
    #[test]
    fn links_read_their_mode() {
        assert_eq!(link_mode("path=%2Fa.md"), Ok(None));
        assert_eq!(link_mode("path=%2Fa.md&mode=edit"), Ok(Some("edit")));
        assert_eq!(link_mode("mode=read&path=%2Fa.md"), Ok(Some("read")));
        for bad in ["mode=Edit", "mode=", "mode=write", "mode=edit%20"] {
            let e = link_mode(bad).unwrap_err();
            assert!(e.contains("use `read` or `edit`"), "{bad}: {e}");
        }
    }

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
